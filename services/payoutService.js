const axios = require('axios');
const db = require('../database/db');
const LNbitsService = require('./lnbitsService');
const BlinkService = require('./blinkService');
const AlbyService = require('./albyService');
const BinanceService = require('./binanceService');
const TelegramService = require('./telegramService');

/**
 * In-memory concurrency Mutex locks per reseller ID
 * Ensures only ONE payout or sweep operation runs at any given millisecond per account.
 */
class ResellerMutex {
    static activeLocks = new Map();

    static async acquire(resellerId, fn) {
        const id = String(resellerId);
        while (this.activeLocks.has(id)) {
            await this.activeLocks.get(id);
        }

        let resolveLock;
        const lockPromise = new Promise(r => { resolveLock = r; });
        this.activeLocks.set(id, lockPromise);

        try {
            return await fn();
        } finally {
            this.activeLocks.delete(id);
            resolveLock();
        }
    }
}

/**
 * Payout & Automated Settlement Engine
 * Coordinates Inbound LN Payments -> Instant Lightning Payouts -> Automated Binance Sweeping
 */
class PayoutService {
    /**
     * Get live BTC spot price in USD with caching
     */
    static lastBtcPrice = 65000;
    static lastBtcPriceFetch = 0;

    static async getBtcPrice() {
        if (Date.now() - this.lastBtcPriceFetch < 30000) { // 30s cache
            return this.lastBtcPrice;
        }
        try {
            const resp = await axios.get('https://api.coinbase.com/v2/prices/BTC-USD/spot', { timeout: 4000 });
            const price = parseFloat(resp.data?.data?.amount);
            if (!isNaN(price) && price > 0) {
                this.lastBtcPrice = price;
                this.lastBtcPriceFetch = Date.now();
                return price;
            }
        } catch (e) {
            // Keep previous cached price
        }
        return this.lastBtcPrice;
    }

    /**
     * Resolve a Lightning Address (e.g. user@blink.sv or user@coinos.io) to a BOLT11 invoice
     */
    static async resolveLightningAddress(address, amountSats) {
        if (!address || !address.includes('@')) {
            throw new Error(`Invalid Lightning address format: "${address}". Expected format username@domain.`);
        }

        const sats = parseInt(amountSats, 10);
        if (isNaN(sats) || sats <= 0) {
            throw new Error(`Invalid satoshi amount for LNURL resolution: ${amountSats}`);
        }

        const [user, domain] = address.trim().split('@');
        const lnurlRes = await axios.get(`https://${domain}/.well-known/lnurlp/${user}`, { timeout: 6000 });

        if (!lnurlRes.data || !lnurlRes.data.callback) {
            throw new Error(`Failed to resolve LNURL parameters for address: ${address}`);
        }

        const millisats = sats * 1000;
        const invRes = await axios.get(`${lnurlRes.data.callback}?amount=${millisats}`, { timeout: 6000 });

        if (!invRes.data || !invRes.data.pr) {
            throw new Error(`Failed to fetch payment request from ${address}`);
        }

        return invRes.data.pr;
    }

    /**
     * Pay a BOLT11 invoice via the reseller's configured active gateway (LNbits, Blink, Alby)
     */
    static async executeGatewayPayment(reseller, bolt11, memo = 'Auto Settlement') {
        const type = reseller.wallet_type;

        if (type === 'lnbits') {
            if (!reseller.lnbits_admin_key) {
                throw new Error('LNbits Admin Key is required to execute outbound sweeps & payouts.');
            }
            const res = await LNbitsService.payInvoice({
                url: reseller.lnbits_url,
                adminKey: reseller.lnbits_admin_key,
                bolt11
            });
            return {
                gateway: 'lnbits',
                txid: res.checking_id || res.payment_hash,
                preimage: res.preimage,
                fee_sats: res.fee_sats || 0
            };
        }

        if (type === 'blink') {
            if (!reseller.blink_api_key) {
                throw new Error('Blink API Key is required for outbound payments.');
            }
            const res = await BlinkService.payInvoice({
                apiKey: reseller.blink_api_key,
                walletId: reseller.blink_wallet_id,
                paymentRequest: bolt11,
                memo
            });
            return {
                gateway: 'blink',
                txid: res.transaction_id || `blink_${Date.now()}`,
                fee_sats: res.fee_sats || 0
            };
        }

        if (type === 'alby') {
            if (!reseller.alby_access_token) {
                throw new Error('Alby Access Token is required for outbound payments.');
            }
            const res = await AlbyService.payInvoice({
                accessToken: reseller.alby_access_token,
                bolt11
            });
            return {
                gateway: 'alby',
                txid: res.payment_hash,
                preimage: res.preimage,
                fee_sats: res.fee_sats || 0
            };
        }

        throw new Error(`Gateway '${type}' does not support automated outbound settlement.`);
    }

    /**
     * Trigger auto-settlement pipeline when a payment is marked 'paid'
     * Uses Mutex lock to prevent duplicate sweeps.
     */
    static async processAutoSettlement(paymentId, io = null) {
        return ResellerMutex.acquire(`payment_${paymentId}`, async () => {
            try {
                const [payments] = await db.query(
                    `SELECT p.*, r.*, p.id as payment_id, r.id as reseller_id
                     FROM payments p
                     JOIN resellers r ON p.reseller_id = r.id
                     WHERE p.id = ?`,
                    [paymentId]
                );

                if (!payments.length) return;
                const payment = payments[0];

                // Check if this payment was already swept or processed
                const [existingSweeps] = await db.query(
                    "SELECT id FROM auto_sweeps WHERE payment_id = ? AND status = 'completed'",
                    [payment.payment_id]
                );
                if (existingSweeps.length) {
                    return; // Idempotent: already swept
                }

                const btcPrice = await this.getBtcPrice();

                // Compute exact satoshis
                const storedBtcAmount = parseFloat(payment.btc_amount) || 0;
                const totalSats = storedBtcAmount > 0
                    ? Math.round(storedBtcAmount * 100_000_000)
                    : Math.round((payment.amount_usd / btcPrice) * 100_000_000);

                // 1. Instant LN Payout (e.g. payout percentage to merchant Lightning address)
                if (payment.auto_payout_enabled && payment.auto_payout_address) {
                    const payoutPercent = Math.min(100, Math.max(1, payment.auto_payout_percent || 100));
                    const payoutSats = Math.round((totalSats * payoutPercent) / 100);
                    const payoutUsd = (payment.amount_usd * payoutPercent) / 100;

                    if (payoutSats > 10) {
                        try {
                            const bolt11 = await this.resolveLightningAddress(payment.auto_payout_address, payoutSats);
                            const payRes = await this.executeGatewayPayment(payment, bolt11, `Instant Payout ${payment.invoice_id}`);

                            await db.query(
                                `INSERT INTO auto_sweeps (reseller_id, payment_id, sweep_type, amount_sats, amount_usd, target_destination, txid, preimage, fee_sats, status)
                                 VALUES (?, ?, 'instant_ln_payout', ?, ?, ?, ?, ?, ?, 'completed')`,
                                [payment.reseller_id, payment.payment_id, payoutSats, payoutUsd, payment.auto_payout_address, payRes.txid, payRes.preimage || null, payRes.fee_sats || 0]
                            );

                            if (io) {
                                io.to(`reseller:${payment.reseller_id}`).emit('sweep:update', {
                                    type: 'instant_ln_payout',
                                    amount_usd: payoutUsd,
                                    destination: payment.auto_payout_address,
                                    status: 'completed'
                                });
                            }
                        } catch (payoutErr) {
                            console.error('Instant LN Payout Failed:', payoutErr.message);
                            await db.query(
                                `INSERT INTO auto_sweeps (reseller_id, payment_id, sweep_type, amount_sats, amount_usd, target_destination, status, error_message)
                                 VALUES (?, ?, 'instant_ln_payout', ?, ?, ?, 'failed', ?)`,
                                [payment.reseller_id, payment.payment_id, payoutSats, payoutUsd, payment.auto_payout_address, payoutErr.message]
                            );
                        }
                    }
                }

                // 2. Binance Auto-Sweep
                if (payment.binance_auto_sweep_enabled && payment.binance_api_key && payment.binance_api_secret) {
                    const threshold = payment.binance_sweep_threshold_usd || 0;
                    const minBinanceDepositSats = payment.binance_sweep_type === 'onchain' ? 100000 : 10000;

                    if (totalSats < minBinanceDepositSats) {
                        const reason = `Held in ${payment.wallet_type ? payment.wallet_type.toUpperCase() : 'Wallet'}: $${payment.amount_usd} (${totalSats} sats) is below Binance min deposit limit (${minBinanceDepositSats} sats)`;
                        await db.query(
                            `INSERT INTO auto_sweeps (reseller_id, payment_id, sweep_type, amount_sats, amount_usd, target_destination, status, error_message)
                             VALUES (?, ?, 'binance_lightning', ?, ?, 'Binance Account', 'held', ?)`,
                            [payment.reseller_id, payment.payment_id, totalSats, payment.amount_usd, reason]
                        );
                        if (io) {
                            io.to(`reseller:${payment.reseller_id}`).emit('sweep:update', {
                                type: 'binance_lightning',
                                amount_usd: payment.amount_usd,
                                destination: 'Held in Wallet',
                                status: 'held',
                                reason
                            });
                        }
                    } else if (payment.amount_usd >= threshold) {
                        try {
                            const binanceInvoice = await BinanceService.getDepositInvoice({
                                apiKey: payment.binance_api_key,
                                apiSecret: payment.binance_api_secret,
                                amountSats: totalSats,
                                network: payment.binance_sweep_type || 'LIGHTNING'
                            });

                            const bolt11 = binanceInvoice.address;
                            if (!bolt11) throw new Error('Binance did not return a valid Lightning invoice.');

                            const sweepRes = await this.executeGatewayPayment(payment, bolt11, `Binance Auto-Sweep ${payment.invoice_id}`);

                            await db.query(
                                `INSERT INTO auto_sweeps (reseller_id, payment_id, sweep_type, amount_sats, amount_usd, target_destination, txid, preimage, fee_sats, status)
                                 VALUES (?, ?, 'binance_lightning', ?, ?, 'Binance Account', ?, ?, ?, 'completed')`,
                                [payment.reseller_id, payment.payment_id, totalSats, payment.amount_usd, sweepRes.txid, sweepRes.preimage || null, sweepRes.fee_sats || 0]
                            );

                            if (io) {
                                io.to(`reseller:${payment.reseller_id}`).emit('sweep:update', {
                                    type: 'binance_lightning',
                                    amount_usd: payment.amount_usd,
                                    destination: 'Binance Account',
                                    status: 'completed'
                                });
                            }
                        } catch (sweepErr) {
                            console.error('Binance Auto-Sweep Failed:', sweepErr.message);
                            const reason = sweepErr.response?.data?.msg || sweepErr.message;
                            await db.query(
                                `INSERT INTO auto_sweeps (reseller_id, payment_id, sweep_type, amount_sats, amount_usd, target_destination, status, error_message)
                                 VALUES (?, ?, 'binance_lightning', ?, ?, 'Binance Account', 'failed', ?)`,
                                [payment.reseller_id, payment.payment_id, totalSats, payment.amount_usd, reason]
                            );
                        }
                    }
                }

                // 3. Send Telegram Notification if configured
                if (payment.telegram_bot_token && payment.telegram_chat_id) {
                    const isSwept = (payment.binance_auto_sweep_enabled && totalSats >= 10000);
                    TelegramService.sendPaymentAlert({
                        botToken: payment.telegram_bot_token,
                        chatId: payment.telegram_chat_id,
                        payment: { ...payment, sats: totalSats },
                        settlementStatus: isSwept ? 'swept' : 'held',
                        sweepNote: isSwept ? 'Auto-deposited to Binance Spot' : (totalSats < 10000 ? 'Below Binance 10,000 sats min deposit' : null)
                    }).catch(err => console.error('Telegram notification error:', err.message));
                }
            } catch (err) {
                console.error('Error processing auto-settlement:', err);
            }
        });
    }

    /**
     * Periodically check wallet balances and auto-sweep to Binance
     * Uses ResellerMutex to guarantee zero race conditions across intervals.
     */
    static async checkAndSweepBalances(io = null) {
        try {
            const [resellers] = await db.query(
                `SELECT * FROM resellers 
                 WHERE binance_auto_sweep_enabled = 1 
                   AND binance_sweep_wallet_balance_enabled = 1 
                   AND binance_api_key IS NOT NULL 
                   AND binance_api_secret IS NOT NULL
                   AND wallet_type IN ('blink', 'lnbits', 'alby')`
            );

            if (!resellers.length) return;
            const btcPrice = await this.getBtcPrice();

            for (const reseller of resellers) {
                await ResellerMutex.acquire(reseller.id, async () => {
                    try {
                        let balanceSats = 0;

                        if (reseller.wallet_type === 'blink') {
                            const details = await BlinkService.getWalletDetails({ apiKey: reseller.blink_api_key });
                            balanceSats = details.balance_sats || 0;
                        } else if (reseller.wallet_type === 'lnbits') {
                            const details = await LNbitsService.getWalletDetails({
                                url: reseller.lnbits_url,
                                invoiceKey: reseller.lnbits_invoice_key
                            });
                            balanceSats = details.balance_sats || 0;
                        } else if (reseller.wallet_type === 'alby' && reseller.alby_access_token) {
                            const details = await AlbyService.getAccountDetails({ accessToken: reseller.alby_access_token });
                            balanceSats = details.balance_sats || 0;
                        } else {
                            return;
                        }

                        balanceSats = parseInt(balanceSats, 10);
                        if (isNaN(balanceSats) || balanceSats <= 0) return;

                        const thresholdUsd = parseFloat(reseller.binance_sweep_threshold_usd) || 0;
                        const thresholdSats = Math.round((thresholdUsd / btcPrice) * 100000000);

                        // Binance Lightning minimum deposit is 10,000 sats (~0.0001 BTC)
                        const minBinanceDepositSats = reseller.binance_sweep_type === 'onchain' ? 100000 : 10000;

                        // Dynamic fee reserve buffer (1.5% or 1000 sats for lightning, 20000 for on-chain)
                        const bufferSats = reseller.binance_sweep_type === 'onchain'
                            ? 20000
                            : Math.max(1000, Math.ceil(balanceSats * 0.015));

                        const sweepAmtSats = balanceSats - bufferSats;

                        if (sweepAmtSats < minBinanceDepositSats || sweepAmtSats < thresholdSats) {
                            return; // Below threshold or minimum deposit limit
                        }

                        console.log(`[Auto-Sweep] Sweeping ${sweepAmtSats} sats for reseller ${reseller.username} to Binance`);

                        const binanceInvoice = await BinanceService.getDepositInvoice({
                            apiKey: reseller.binance_api_key,
                            apiSecret: reseller.binance_api_secret,
                            amountSats: sweepAmtSats,
                            network: reseller.binance_sweep_type || 'LIGHTNING'
                        });

                        const bolt11 = binanceInvoice.address;
                        if (!bolt11) throw new Error('Binance did not return a valid Lightning invoice.');

                        const sweepRes = await this.executeGatewayPayment(reseller, bolt11, 'Binance Auto-Sweep Wallet Balance');
                        const sweepUsd = (sweepAmtSats / 100000000) * btcPrice;

                        await db.query(
                            `INSERT INTO auto_sweeps (reseller_id, sweep_type, amount_sats, amount_usd, target_destination, txid, preimage, fee_sats, status)
                             VALUES (?, ?, ?, ?, 'Binance Account', ?, ?, ?, 'completed')`,
                            [
                                reseller.id,
                                reseller.binance_sweep_type === 'onchain' ? 'binance_onchain' : 'binance_lightning',
                                sweepAmtSats,
                                sweepUsd,
                                sweepRes.txid,
                                sweepRes.preimage || null,
                                sweepRes.fee_sats || 0
                            ]
                        );

                        if (io) {
                            io.to(`reseller:${reseller.id}`).emit('sweep:update', {
                                type: reseller.binance_sweep_type === 'onchain' ? 'binance_onchain' : 'binance_lightning',
                                amount_usd: sweepUsd,
                                destination: 'Binance Account',
                                status: 'completed'
                            });
                        }

                        if (reseller.telegram_bot_token && reseller.telegram_chat_id) {
                            await TelegramService.sendSweepAlert({
                                botToken: reseller.telegram_bot_token,
                                chatId: reseller.telegram_chat_id,
                                sweep: {
                                    amount_usd: sweepUsd,
                                    amount_sats: sweepAmtSats,
                                    target_destination: 'Binance Account',
                                    status: 'completed',
                                    txid: sweepRes.txid
                                }
                            }).catch(e => console.error('Failed to dispatch Telegram sweep alert:', e.message));
                        }
                    } catch (resellerErr) {
                        console.error(`[Auto-Sweep] Failed for reseller ${reseller.username}:`, resellerErr.message);
                        try {
                            await db.query(
                                `INSERT INTO auto_sweeps
                                 (reseller_id, sweep_type, amount_sats, amount_usd, target_destination, status, error_message)
                                 VALUES (?, ?, 0, 0, 'Binance Account', 'failed', ?)`,
                                [
                                    reseller.id,
                                    reseller.binance_sweep_type === 'onchain' ? 'binance_onchain' : 'binance_lightning',
                                    resellerErr.message
                                ]
                            );
                        } catch (dbErr) {
                            console.error('[Auto-Sweep] Failed to log sweep error to DB:', dbErr.message);
                        }
                    }
                });
            }
        } catch (err) {
            console.error('Error in checkAndSweepBalances:', err);
        }
    }
}

module.exports = PayoutService;
