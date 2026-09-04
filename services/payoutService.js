const axios = require('axios');
const db = require('../database/db');
const LNbitsService = require('./lnbitsService');
const BlinkService = require('./blinkService');
const AlbyService = require('./albyService');
const BinanceService = require('./binanceService');
const TelegramService = require('./telegramService');
const SettlementJobService = require('./settlementJobService');
const PlatformWalletFeeService = require('./platformWalletFeeService');

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
    static sweepFailures = new Map();
    static sweepBackoffMs = [900_000, 900_000, 900_000, 3_600_000];

    static runExclusive(resellerId, fn) {
        return ResellerMutex.acquire(`wallet:${resellerId}`, fn);
    }

    static allocateSettlement({ receivedSats, payoutEnabled, payoutPercent, binanceEnabled, feeReserveSats = 1000 }) {
        const received = Math.max(0, Math.trunc(Number(receivedSats) || 0));
        const hasOutgoing = Boolean(payoutEnabled || binanceEnabled);
        const reserve = hasOutgoing
            ? Math.min(received, Math.max(0, Math.trunc(Number(feeReserveSats) || 0)))
            : 0;
        const spendable = received - reserve;
        const percent = Math.min(100, Math.max(0, Number(payoutPercent) || 0));
        const merchantPayoutSats = payoutEnabled
            ? Math.min(spendable, Math.floor((spendable * percent) / 100))
            : 0;
        const binanceSweepSats = binanceEnabled
            ? Math.max(0, spendable - merchantPayoutSats)
            : 0;
        const remainingSats = received - merchantPayoutSats - binanceSweepSats;

        if (merchantPayoutSats + binanceSweepSats + reserve > received || remainingSats < 0) {
            throw new Error('Settlement allocation exceeds received satoshis');
        }

        return {
            receivedSats: received,
            merchantPayoutSats,
            platformFeeSats: 0,
            feeReserveSats: reserve,
            remainingSats,
            binanceSweepSats
        };
    }

    static async operationCompleted(paymentId, sweepType) {
        if (await SettlementJobService.isCompleted(paymentId, sweepType)) return true;
        const [rows] = await db.query(
            "SELECT id FROM auto_sweeps WHERE payment_id = ? AND sweep_type = ? AND status = 'completed' LIMIT 1",
            [paymentId, sweepType]
        );
        return rows.length > 0;
    }

    static getSweepBackoff(resellerId) {
        return this.sweepFailures.get(String(resellerId)) || null;
    }

    static recordSweepFailure(resellerId, error) {
        const id = String(resellerId);
        const previous = this.sweepFailures.get(id);
        const failures = (previous?.failures || 0) + 1;
        const delay = this.sweepBackoffMs[Math.min(failures - 1, this.sweepBackoffMs.length - 1)];
        const state = {
            failures,
            nextAttemptAt: Date.now() + delay,
            error: error?.response?.data?.msg || error?.response?.data?.message || error?.message || 'Unknown sweep error'
        };
        this.sweepFailures.set(id, state);
        return state;
    }

    static clearSweepFailure(resellerId) {
        this.sweepFailures.delete(String(resellerId));
    }

    static async claimWalletSweep(resellerId) {
        await db.query(
            `INSERT OR IGNORE INTO wallet_sweep_locks (reseller_id, locked_until)
             VALUES (?, datetime('now','-1 seconds'))`,
            [resellerId]
        );
        const [result] = await db.query(
            `UPDATE wallet_sweep_locks SET locked_until=datetime('now','+2 minutes'),updated_at=datetime('now')
             WHERE reseller_id=? AND locked_until<=datetime('now')
             AND (last_error IS NULL OR last_error NOT LIKE 'UNKNOWN:%')
             AND NOT EXISTS (SELECT 1 FROM settlement_jobs WHERE reseller_id=? AND status='unknown')`,
            [resellerId, resellerId]
        );
        return Boolean(result && result.affectedRows === 1);
    }

    static async completeWalletSweepAttempt(resellerId) {
        await db.query(
            `UPDATE wallet_sweep_locks SET failure_count=0,last_error=NULL,
             locked_until=datetime('now','+1 minutes'),updated_at=datetime('now') WHERE reseller_id=?`,
            [resellerId]
        );
        this.clearSweepFailure(resellerId);
    }

    static async markSweepDispatched(resellerId) {
        await db.query(
            `UPDATE wallet_sweep_locks SET locked_until='9999-12-31 23:59:59',
             last_error='UNKNOWN: Outbound request in progress; reconcile if interrupted',
             updated_at=datetime('now') WHERE reseller_id=?`,
            [resellerId]
        );
    }

    static async failWalletSweepAttempt(resellerId, error) {
        const raw = String(error?.response?.data?.msg || error?.response?.data?.message || error?.message || 'Unknown sweep error');
        const message = error?.externalOutcomeUnknown ? 'UNKNOWN: Outbound payment outcome requires reconciliation; automatic retries blocked'
            : /031083|429|rate.?limit|too (?:many|frequen)/i.test(raw) ? 'Binance rate limit - cooling down'
            : /admin.*key/i.test(raw) ? 'Admin key required for outbound payments'
            : /520/.test(raw) ? 'Upstream service unavailable (520) - cooling down'
            : raw.slice(0, 1000);
        await db.query(
            `UPDATE wallet_sweep_locks SET
             locked_until=CASE WHEN ?=1 THEN '9999-12-31 23:59:59'
                               WHEN failure_count>=2 THEN datetime('now','+60 minutes')
                               WHEN failure_count>=1 THEN datetime('now','+15 minutes')
                               ELSE datetime('now','+15 minutes') END,
             failure_count=failure_count+1,last_error=?,updated_at=datetime('now') WHERE reseller_id=?`,
            [error?.externalOutcomeUnknown ? 1 : 0, message, resellerId]
        );
        return { error: message };
    }

    static async resetSweepCooldown(resellerId) {
        await db.query(
            `UPDATE wallet_sweep_locks SET locked_until=datetime('now','-1 seconds'),
             failure_count=0,last_error=NULL,updated_at=datetime('now')
             WHERE reseller_id=? AND last_error IS NOT NULL AND last_error NOT LIKE 'UNKNOWN:%'`,
            [resellerId]
        );
        this.clearSweepFailure(resellerId);
    }

    static async validateSweepBalance(reseller, amountSats) {
        if (reseller.wallet_type === 'lnbits' && !reseller.lnbits_admin_key) {
            const error = new Error('Admin key required for outbound LNbits payments');
            error.permanent = true;
            throw error;
        }
        const available = await this.getGatewayBalanceSats(reseller);
        const reserve = Math.max(1000, Math.ceil(amountSats * 0.015));
        return { sufficient: available >= amountSats + reserve, available, reserve };
    }

    static async findRecentFailedWalletSweep(resellerId, sweepType, amountSats) {
        const [rows] = await db.query(
            `SELECT id FROM auto_sweeps
             WHERE reseller_id = ? AND sweep_type = ? AND amount_sats = ?
               AND status = 'failed'
               AND created_at >= datetime('now', '-120 minutes')
             ORDER BY id DESC LIMIT 1`,
            [resellerId, sweepType, amountSats]
        );
        return rows[0]?.id || null;
    }

    static async recordCompletedWalletSweep({ resellerId, sweepType, amountSats, amountUsd, payment }) {
        const failedId = await this.findRecentFailedWalletSweep(resellerId, sweepType, amountSats);
        if (failedId) {
            await db.query(
                `UPDATE auto_sweeps SET amount_usd = ?, target_destination = 'Binance Account',
                 txid = ?, preimage = ?, fee_sats = ?, status = 'completed', error_message = NULL
                 WHERE id = ?`,
                [amountUsd, payment.txid, payment.preimage || null, payment.fee_sats || 0, failedId]
            );
            return failedId;
        }

        const [result] = await db.query(
            `INSERT INTO auto_sweeps (reseller_id, sweep_type, amount_sats, amount_usd, target_destination, txid, preimage, fee_sats, status)
             VALUES (?, ?, ?, ?, 'Binance Account', ?, ?, ?, 'completed')`,
            [resellerId, sweepType, amountSats, amountUsd, payment.txid, payment.preimage || null, payment.fee_sats || 0]
        );
        return result.insertId;
    }

    static walletFeeHandlers() {
        return {
            loadReseller: async id => {
                const [rows] = await db.query('SELECT * FROM resellers WHERE id=? LIMIT 1', [id]);
                return rows[0] || null;
            },
            resolveInvoice: (address, sats) => this.resolveLightningAddress(address, sats),
            payInvoice: (reseller, bolt11, memo) => this.executeGatewayPayment(reseller, bolt11, memo)
        };
    }

    static async processPlatformWalletFee({ sourceSweepId, resellerId, sweepAmountUsd, btcPrice }) {
        try {
            return await PlatformWalletFeeService.enqueueAndProcess(
                { sourceSweepId, resellerId, sweepAmountUsd, btcPrice },
                this.walletFeeHandlers()
            );
        } catch (err) {
            console.error('[Wallet Fee] Processing failed safely:', err.message);
            return 'error';
        }
    }

    static async processDuePlatformWalletFees() {
        const rows = await PlatformWalletFeeService.due(20);
        for (const row of rows) await PlatformWalletFeeService.processRow(row, this.walletFeeHandlers());
        return rows.length;
    }

    static async recordFailedWalletSweep({ resellerId, sweepType, amountSats, amountUsd, errorMessage }) {
        const failedId = await this.findRecentFailedWalletSweep(resellerId, sweepType, amountSats);
        if (failedId) {
            await db.query(
                `UPDATE auto_sweeps SET amount_usd = ?, error_message = ?, created_at = CURRENT_TIMESTAMP
                 WHERE id = ?`,
                [amountUsd, errorMessage, failedId]
            );
            return;
        }

        await db.query(
            `INSERT INTO auto_sweeps
             (reseller_id, sweep_type, amount_sats, amount_usd, target_destination, status, error_message)
             VALUES (?, ?, ?, ?, 'Binance Account', 'failed', ?)`,
            [resellerId, sweepType, amountSats, amountUsd, errorMessage]
        );
    }

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

    static async getGatewayBalanceSats(reseller) {
        if (reseller.wallet_type === 'lnbits') {
            const details = await LNbitsService.getWalletDetails({
                url: reseller.lnbits_url,
                invoiceKey: reseller.lnbits_invoice_key
            });
            return Math.max(0, parseInt(details.balance_sats, 10) || 0);
        }

        if (reseller.wallet_type === 'blink') {
            const details = await BlinkService.getWalletDetails({ apiKey: reseller.blink_api_key });
            return Math.max(0, parseInt(details.balance_sats, 10) || 0);
        }

        if (reseller.wallet_type === 'alby') {
            const details = await AlbyService.getAccountDetails({ accessToken: reseller.alby_access_token });
            return Math.max(0, parseInt(details.balance_sats, 10) || 0);
        }

        const err = new Error(`Gateway '${reseller.wallet_type || 'unknown'}' does not expose a spendable balance.`);
        err.statusCode = 400;
        throw err;
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
     * Resolve a Lightning Address to an invoice and retain the optional LUD-21
     * verification URL used to confirm payment without wallet API credentials.
     */
    static async resolveLightningAddressInvoice(address, amountSats) {
        const normalized = String(address || '').trim().toLowerCase();
        const match = normalized.match(/^([^\s@]+)@([^\s@]+\.[^\s@]+)$/);
        if (!match) throw new Error('Invalid Lightning Address format.');

        const sats = Math.trunc(Number(amountSats));
        if (!Number.isSafeInteger(sats) || sats <= 0) {
            throw new Error('Invalid satoshi amount for Lightning Address invoice.');
        }

        const [, username, domain] = match;
        const metadataResponse = await axios.get(
            `https://${domain}/.well-known/lnurlp/${encodeURIComponent(username)}`,
            { timeout: 7000, maxRedirects: 3, headers: { Accept: 'application/json' } }
        );
        const metadata = metadataResponse.data || {};
        if (String(metadata.status || '').toUpperCase() === 'ERROR') {
            throw new Error(metadata.reason || 'Wallet provider rejected the Lightning Address.');
        }
        if (metadata.tag !== 'payRequest' || !metadata.callback) {
            throw new Error('Wallet provider returned invalid LNURL-pay metadata.');
        }

        const minMsats = Number(metadata.minSendable);
        const maxMsats = Number(metadata.maxSendable);
        const amountMsats = sats * 1000;
        if (!Number.isSafeInteger(amountMsats) || !Number.isFinite(minMsats) || !Number.isFinite(maxMsats)) {
            throw new Error('Wallet provider returned invalid payment limits.');
        }
        if (amountMsats < minMsats || amountMsats > maxMsats) {
            throw new Error(`Requested amount is outside the wallet limit (${Math.ceil(minMsats / 1000)}-${Math.floor(maxMsats / 1000)} sats).`);
        }

        const callbackUrl = new URL(metadata.callback);
        if (callbackUrl.protocol !== 'https:') throw new Error('Wallet callback must use HTTPS.');
        callbackUrl.searchParams.set('amount', String(amountMsats));

        const invoiceResponse = await axios.get(callbackUrl.toString(), {
            timeout: 10000,
            maxRedirects: 3,
            headers: { Accept: 'application/json' }
        });
        const invoice = invoiceResponse.data || {};
        if (String(invoice.status || '').toUpperCase() === 'ERROR') {
            throw new Error(invoice.reason || 'Wallet provider rejected the invoice request.');
        }
        if (typeof invoice.pr !== 'string' || !/^ln(?:bc|tb|bcrt)[0-9a-z]+$/i.test(invoice.pr)) {
            throw new Error('Wallet provider did not return a valid BOLT11 invoice.');
        }

        let verifyUrl = null;
        if (invoice.verify) {
            const parsedVerifyUrl = new URL(invoice.verify);
            if (parsedVerifyUrl.protocol === 'https:') verifyUrl = parsedVerifyUrl.toString();
        }

        return { paymentRequest: invoice.pr, verifyUrl };
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
        const [payments] = await db.query(
            `SELECT p.*, r.*, p.id as payment_id, r.id as reseller_id, p.created_at as payment_created_at,
                    pl.slug, pl.title as link_title
             FROM payments p
             JOIN resellers r ON p.reseller_id = r.id
             LEFT JOIN payment_links pl ON pl.id = p.link_id
             WHERE p.id = ?`,
            [paymentId]
        );
        if (!payments.length) return;
        const payment = payments[0];

        return this.runExclusive(payment.reseller_id, async () => {
            try {

                // Compute exact satoshis
                const storedSats = Math.trunc(Number(payment.amount_sats) || 0);
                const storedBtcAmount = Number(payment.btc_amount) || 0;
                const totalSats = storedSats > 0
                    ? storedSats
                    : (storedBtcAmount > 0 ? Math.round(storedBtcAmount * 100_000_000) : 0);
                if (totalSats <= 0) {
                    throw new Error('Settlement blocked: payment has no persisted satoshi amount');
                }
                const paymentUsd = Number(payment.total_usd || payment.amount_usd || 0);
                const walletFeeConfig = await PlatformWalletFeeService.settings();
                const impliedBtcPrice = paymentUsd > 0 ? (paymentUsd / totalSats) * 100000000 : await this.getBtcPrice();
                const walletFeeReserveSats = walletFeeConfig.enabled && paymentUsd >= walletFeeConfig.thresholdUsd && PlatformWalletFeeService.isLightningAddress(walletFeeConfig.destination)
                    ? Math.round((walletFeeConfig.amountUsd / impliedBtcPrice) * 100000000) + 1000
                    : 0;
                const allocation = this.allocateSettlement({
                    receivedSats: totalSats,
                    payoutEnabled: Boolean(payment.auto_payout_enabled && payment.auto_payout_address),
                    payoutPercent: payment.auto_payout_percent,
                    binanceEnabled: Boolean(payment.binance_auto_sweep_enabled && payment.binance_api_key && payment.binance_api_secret),
                    feeReserveSats: Math.max(payment.settlement_fee_reserve_sats == null ? 1000 : payment.settlement_fee_reserve_sats, walletFeeReserveSats)
                });

                // Notify as soon as receipt is confirmed. Waiting for Binance or
                // another outbound settlement made receipt alerts appear late or
                // disappear when a later settlement step failed.
                if (payment.telegram_bot_token && payment.telegram_chat_id &&
                    await SettlementJobService.claim({
                        paymentId: payment.payment_id,
                        resellerId: payment.reseller_id,
                        operationKey: 'telegram_payment_notification',
                        amountSats: 0
                    })) {
                    try {
                        const notification = await TelegramService.sendPaymentAlert({
                            botToken: payment.telegram_bot_token,
                            chatId: payment.telegram_chat_id,
                            payment: { ...payment, amount_sats: totalSats, sats: totalSats },
                            settlementStatus: 'processing',
                            sweepNote: payment.binance_auto_sweep_enabled
                                ? 'Payment confirmed; Binance settlement is processing'
                                : 'Payment confirmed'
                        });
                        if (!notification?.sent) throw new Error(notification?.error || 'Telegram notification was not sent');
                        const messageId = Number(notification.data?.result?.message_id);
                        if (Number.isSafeInteger(messageId) && messageId > 0) {
                            await db.query(
                                `INSERT INTO telegram_payment_messages (payment_id,reseller_id,chat_id,message_id,status)
                                 VALUES (?,?,?,?, 'received')
                                 ON CONFLICT(payment_id) DO UPDATE SET chat_id=excluded.chat_id,message_id=excluded.message_id,
                                 status='received',updated_at=datetime('now')`,
                                [payment.payment_id, payment.reseller_id, String(payment.telegram_chat_id), messageId]
                            );
                        }
                        await SettlementJobService.complete(payment.payment_id, 'telegram_payment_notification');
                    } catch (notificationErr) {
                        await SettlementJobService.fail(payment.payment_id, 'telegram_payment_notification', notificationErr);
                        console.error('Telegram payment notification error:', notificationErr.message);
                    }
                }

                // 1. Instant LN Payout (e.g. payout percentage to merchant Lightning address)
                if (payment.auto_payout_enabled && payment.auto_payout_address) {
                    const payoutSats = allocation.merchantPayoutSats;
                    const payoutUsd = totalSats > 0
                        ? (Number(payment.total_usd || payment.amount_usd || 0) * payoutSats) / totalSats
                        : 0;

                    if (payoutSats > 10 && !(await this.operationCompleted(payment.payment_id, 'instant_ln_payout')) &&
                        await SettlementJobService.claim({
                            paymentId: payment.payment_id,
                            resellerId: payment.reseller_id,
                            operationKey: 'instant_ln_payout',
                            amountSats: payoutSats
                        })) {
                        try {
                            const bolt11 = await this.resolveLightningAddress(payment.auto_payout_address, payoutSats);
                            const payRes = await this.executeGatewayPayment(payment, bolt11, `Instant Payout ${payment.invoice_id}`);

                            await db.query(
                                `INSERT INTO auto_sweeps (reseller_id, payment_id, sweep_type, amount_sats, amount_usd, target_destination, txid, preimage, fee_sats, status)
                                 VALUES (?, ?, 'instant_ln_payout', ?, ?, ?, ?, ?, ?, 'completed')`,
                                [payment.reseller_id, payment.payment_id, payoutSats, payoutUsd, payment.auto_payout_address, payRes.txid, payRes.preimage || null, payRes.fee_sats || 0]
                            );
                            await SettlementJobService.complete(payment.payment_id, 'instant_ln_payout', payRes.txid);

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
                            await SettlementJobService.fail(payment.payment_id, 'instant_ln_payout', payoutErr);
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
                    const binanceSats = allocation.binanceSweepSats;
                    const binanceUsd = totalSats > 0
                        ? (Number(payment.total_usd || payment.amount_usd || 0) * binanceSats) / totalSats
                        : 0;

                    if (binanceSats < minBinanceDepositSats &&
                        await SettlementJobService.claim({
                            paymentId: payment.payment_id,
                            resellerId: payment.reseller_id,
                            operationKey: 'binance_lightning',
                            amountSats: binanceSats
                        })) {
                        const reason = `Held in ${payment.wallet_type ? payment.wallet_type.toUpperCase() : 'Wallet'}: ${binanceSats} allocated sats is below Binance min deposit limit (${minBinanceDepositSats} sats)`;
                        await SettlementJobService.hold(payment.payment_id, 'binance_lightning', reason);
                        await db.query(
                            `INSERT INTO auto_sweeps (reseller_id, payment_id, sweep_type, amount_sats, amount_usd, target_destination, status, error_message)
                             VALUES (?, ?, 'binance_lightning', ?, ?, 'Binance Account', 'held', ?)`,
                            [payment.reseller_id, payment.payment_id, binanceSats, binanceUsd, reason]
                        );
                        if (io) {
                            io.to(`reseller:${payment.reseller_id}`).emit('sweep:update', {
                                type: 'binance_lightning',
                                amount_usd: binanceUsd,
                                destination: 'Held in Wallet',
                                status: 'held',
                                reason
                            });
                        }
                    } else if (binanceUsd >= threshold && !(await this.operationCompleted(payment.payment_id, 'binance_lightning')) &&
                        await this.claimWalletSweep(payment.reseller_id) &&
                        await SettlementJobService.claim({
                            paymentId: payment.payment_id,
                            resellerId: payment.reseller_id,
                            operationKey: 'binance_lightning',
                            amountSats: binanceSats
                        })) {
                        let outboundStarted = false;
                        try {
                            const balance = await this.validateSweepBalance(payment, binanceSats);
                            const [priorWalletSweeps] = await db.query(
                                `SELECT id FROM auto_sweeps WHERE reseller_id=? AND payment_id IS NULL
                                 AND created_at>=? LIMIT 1`,
                                [payment.reseller_id, payment.payment_created_at]
                            );
                            if (!balance.sufficient || payment.binance_sweep_wallet_balance_enabled || priorWalletSweeps.length) {
                                const reason = !balance.sufficient
                                    ? 'Insufficient spendable balance — held (including network fee reserve)'
                                    : 'Held for wallet-sweep reconciliation; payment must not be swept twice';
                                await SettlementJobService.hold(payment.payment_id, 'binance_lightning', reason);
                                await db.query(
                                    `INSERT INTO auto_sweeps (reseller_id,payment_id,sweep_type,amount_sats,amount_usd,target_destination,status,error_message)
                                     VALUES (?,?,'binance_lightning',?,?,'Binance Account','held',?)`,
                                    [payment.reseller_id,payment.payment_id,binanceSats,binanceUsd,reason]
                                );
                                await this.completeWalletSweepAttempt(payment.reseller_id);
                                return;
                            }
                            const binanceInvoice = await BinanceService.getDepositInvoice({
                                apiKey: payment.binance_api_key,
                                apiSecret: payment.binance_api_secret,
                                amountSats: binanceSats,
                                network: payment.binance_sweep_type || 'LIGHTNING'
                            });

                            const bolt11 = binanceInvoice.address;
                            if (!bolt11) throw new Error('Binance did not return a valid Lightning invoice.');

                            outboundStarted = true;
                            await this.markSweepDispatched(payment.reseller_id);
                            const sweepRes = await this.executeGatewayPayment(payment, bolt11, `Binance Auto-Sweep ${payment.invoice_id}`);

                            const [sweepInsert] = await db.query(
                                `INSERT INTO auto_sweeps (reseller_id, payment_id, sweep_type, amount_sats, amount_usd, target_destination, txid, preimage, fee_sats, status)
                                 VALUES (?, ?, 'binance_lightning', ?, ?, 'Binance Account', ?, ?, ?, 'completed')`,
                                [payment.reseller_id, payment.payment_id, binanceSats, binanceUsd, sweepRes.txid, sweepRes.preimage || null, sweepRes.fee_sats || 0]
                            );
                            await SettlementJobService.complete(payment.payment_id, 'binance_lightning', sweepRes.txid);
                            await this.completeWalletSweepAttempt(payment.reseller_id);

                            const walletFeeStatus = await this.processPlatformWalletFee({
                                sourceSweepId: sweepInsert.insertId,
                                resellerId: payment.reseller_id,
                                sweepAmountUsd: binanceUsd,
                                btcPrice: impliedBtcPrice
                            });

                            if (payment.telegram_bot_token && payment.telegram_chat_id) {
                                const [messages] = await db.query(
                                    'SELECT * FROM telegram_payment_messages WHERE payment_id=? LIMIT 1',
                                    [payment.payment_id]
                                );
                                if (messages[0]) {
                                    const message = TelegramService.buildSettlementUpdate({
                                        payment,
                                        sweep: { amount_sats: binanceSats, txid: sweepRes.txid },
                                        walletFeeStatus: walletFeeStatus === 'skipped' ? null : walletFeeStatus
                                    });
                                    await TelegramService.editMessage({
                                        botToken: payment.telegram_bot_token,
                                        chatId: messages[0].chat_id,
                                        messageId: messages[0].message_id,
                                        message
                                    }).then(() => db.query(
                                        "UPDATE telegram_payment_messages SET status='settled',updated_at=datetime('now') WHERE id=?",
                                        [messages[0].id]
                                    )).catch(err => console.error('[telegram] Settlement message update failed:', err.message));
                                }
                            }

                            if (io) {
                                io.to(`reseller:${payment.reseller_id}`).emit('sweep:update', {
                                    type: 'binance_lightning',
                                    amount_usd: binanceUsd,
                                    destination: 'Binance Account',
                                    status: 'completed'
                                });
                            }
                        } catch (sweepErr) {
                            if (outboundStarted) sweepErr.externalOutcomeUnknown = true;
                            await this.failWalletSweepAttempt(payment.reseller_id, sweepErr);
                            console.error('Binance Auto-Sweep Failed:', sweepErr.message);
                            await SettlementJobService.fail(payment.payment_id, 'binance_lightning', sweepErr);
                            const reason = sweepErr.response?.data?.msg || sweepErr.message;
                            await db.query(
                                `INSERT INTO auto_sweeps (reseller_id, payment_id, sweep_type, amount_sats, amount_usd, target_destination, status, error_message)
                                 VALUES (?, ?, 'binance_lightning', ?, ?, 'Binance Account', 'failed', ?)`,
                                [payment.reseller_id, payment.payment_id, binanceSats, binanceUsd, reason]
                            );
                        }
                    }
                }

            } catch (err) {
                console.error('Error processing auto-settlement:', err);
            }
        });
    }

    static async processDueSettlementJobs(io = null) {
        await SettlementJobService.quarantineStaleProcessing();
        const paymentIds = await SettlementJobService.duePaymentIds(25);
        for (const paymentId of paymentIds) {
            await this.processAutoSettlement(paymentId, io);
        }
        return paymentIds.length;
    }

    /**
     * Periodically check wallet balances and auto-sweep to Binance
     * Uses ResellerMutex to guarantee zero race conditions across intervals.
     */
    static async checkAndSweepBalances(io = null) {
        try {
            await this.processDuePlatformWalletFees();
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
                // A database-backed claim prevents duplicate Binance invoice requests
                // when Passenger temporarily runs more than one Node.js instance.
                if (!(await this.claimWalletSweep(reseller.id))) continue;

                await this.runExclusive(reseller.id, async () => {
                    let sweepAmtSats = 0;
                    let sweepUsd = 0;
                    let outboundStarted = false;
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
                            await this.completeWalletSweepAttempt(reseller.id);
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

                        sweepAmtSats = balanceSats - bufferSats;

                        if (sweepAmtSats < minBinanceDepositSats || sweepAmtSats < thresholdSats) {
                            await this.completeWalletSweepAttempt(reseller.id);
                            return; // Below threshold or minimum deposit limit
                        }

                        const spendable = await this.validateSweepBalance(reseller, sweepAmtSats);
                        if (!spendable.sufficient) {
                            await db.query(
                                `INSERT INTO auto_sweeps (reseller_id,sweep_type,amount_sats,amount_usd,target_destination,status,error_message)
                                 VALUES (?,'binance_lightning',?,?,'Binance Account','held',?)`,
                                [reseller.id,sweepAmtSats,(sweepAmtSats/100000000)*btcPrice,'Insufficient spendable balance — held (including network fee reserve)']
                            );
                            await this.failWalletSweepAttempt(reseller.id, new Error('Insufficient spendable balance — held'));
                            return;
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

                        outboundStarted = true;
                        await this.markSweepDispatched(reseller.id);
                        const sweepRes = await this.executeGatewayPayment(reseller, bolt11, 'Binance Auto-Sweep Wallet Balance');
                        sweepUsd = (sweepAmtSats / 100000000) * btcPrice;

                        const sweepType = reseller.binance_sweep_type === 'onchain' ? 'binance_onchain' : 'binance_lightning';
                        const sourceSweepId = await this.recordCompletedWalletSweep({
                            resellerId: reseller.id,
                            sweepType,
                            amountSats: sweepAmtSats,
                            amountUsd: sweepUsd,
                            payment: sweepRes
                        });
                        await this.processPlatformWalletFee({
                            sourceSweepId,
                            resellerId: reseller.id,
                            sweepAmountUsd: sweepUsd,
                            btcPrice
                        });

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
                        await this.completeWalletSweepAttempt(reseller.id);
                    } catch (resellerErr) {
                        if (outboundStarted) resellerErr.externalOutcomeUnknown = true;
                        const failure = await this.failWalletSweepAttempt(reseller.id, resellerErr);
                        console.error(`[Auto-Sweep] Failed for reseller ${reseller.username}; persistent cooldown active:`, failure.error);

                        // Never create meaningless $0 / 0-sat history rows. A failed
                        // history entry represents a real sweep amount that was attempted.
                        if (sweepAmtSats > 0) {
                            try {
                                await this.recordFailedWalletSweep({
                                    resellerId: reseller.id,
                                    sweepType: reseller.binance_sweep_type === 'onchain' ? 'binance_onchain' : 'binance_lightning',
                                    amountSats: sweepAmtSats,
                                    amountUsd: sweepUsd || ((sweepAmtSats / 100000000) * btcPrice),
                                    errorMessage: `${failure.error} (persistent retry cooldown active)`
                                });
                            } catch (dbErr) {
                                console.error('[Auto-Sweep] Failed to log sweep error to DB:', dbErr.message);
                            }
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
