const axios = require('axios');
const db = require('../database/db');
const LNbitsService = require('./lnbitsService');
const BlinkService = require('./blinkService');
const AlbyService = require('./albyService');
const BinanceService = require('./binanceService');
const TelegramService = require('./telegramService');

/**
 * Payout & Settlement Orchestration Engine
 * Coordinates Gateway Webhooks -> Instant LN Payouts -> Auto-Sweeps to Binance
 */
class PayoutService {
    /**
     * Get live BTC spot price in USD
     */
    static async getBtcPrice() {
        try {
            const resp = await axios.get('https://api.coinbase.com/v2/prices/BTC-USD/spot', { timeout: 3500 });
            return parseFloat(resp.data.data.amount) || 65000;
        } catch (e) {
            return 65000;
        }
    }

    /**
     * Resolve a Lightning Address (e.g. user@blink.sv or user@coinos.io) to a BOLT11 invoice
     */
    static async resolveLightningAddress(address, amountSats) {
        if (!address || !address.includes('@')) {
            throw new Error('Invalid Lightning address format. Expected username@domain');
        }

        const [user, domain] = address.trim().split('@');
        const lnurlRes = await axios.get(`https://${domain}/.well-known/lnurlp/${user}`, { timeout: 4500 });

        if (!lnurlRes.data || !lnurlRes.data.callback) {
            throw new Error(`Failed to resolve LNURL parameters for ${address}`);
        }

        const millisats = Math.round(amountSats * 1000);
        const invRes = await axios.get(`${lnurlRes.data.callback}?amount=${millisats}`, { timeout: 4500 });

        if (!invRes.data || !invRes.data.pr) {
            throw new Error(`Failed to fetch payment request from ${address}`);
        }

        return invRes.data.pr;
    }

    /**
     * Pay a BOLT11 invoice via the reseller's configured gateway
     */
    static async executeGatewayPayment(reseller, bolt11, memo = 'Auto Settlement') {
        const type = reseller.wallet_type;

        if (type === 'lnbits') {
            if (!reseller.lnbits_admin_key) {
                throw new Error('LNbits Admin Key required for outbound payments');
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
                throw new Error('Blink API Key required for outbound payments');
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
                throw new Error('Alby Access Token required for outbound payments');
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

        throw new Error(`Gateway '${type}' does not currently support automated outbound payouts.`);
    }

    /**
     * Trigger auto-settlement pipeline when a payment is marked 'paid'
     */
    static async processAutoSettlement(paymentId, io = null) {
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

            const btcPrice = await this.getBtcPrice();
            const totalSats = Math.round((payment.amount_usd / btcPrice) * 100000000);

            // 1. Check Instant LN Payout (e.g. payout % to merchant/sub-user address)
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

            // 2. Check Binance Auto-Sweep
            if (payment.binance_auto_sweep_enabled && payment.binance_api_key && payment.binance_api_secret) {
                const threshold = payment.binance_sweep_threshold_usd || 0;
                
                // Binance minimum deposit limit for Bitcoin Lightning is 0.0001 BTC (~10,000 sats)
                if (totalSats < 10000 && payment.binance_sweep_type !== 'onchain') {
                    const reason = `Held in ${payment.wallet_type ? payment.wallet_type.toUpperCase() : 'Wallet'}: $${payment.amount_usd} (${totalSats} sats) is below Binance min deposit limit (0.0001 BTC / ~10,000 sats)`;
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
                        // Request Binance Lightning deposit invoice
                        const binanceInvoice = await BinanceService.getDepositInvoice({
                            apiKey: payment.binance_api_key,
                            apiSecret: payment.binance_api_secret,
                            amountSats: totalSats,
                            network: payment.binance_sweep_type || 'LIGHTNING'
                        });

                        const bolt11 = binanceInvoice.address;
                        if (!bolt11) {
                            throw new Error('Binance did not return a valid Lightning invoice.');
                        }

                        // Pay the Binance invoice via active gateway (LNbits, Blink, Alby)
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
    }
}

module.exports = PayoutService;
