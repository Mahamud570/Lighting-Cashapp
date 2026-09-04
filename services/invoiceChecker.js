const axios = require('axios');
const LNbitsService = require('./lnbitsService');
const BlinkService  = require('./blinkService');
const AlbyService = require('./albyService');
const { logSafeError } = require('../utils/safeError');

const lastProviderErrorLog = new Map();
function logProviderCheckError(provider, err) {
    const key = String(provider || 'unknown');
    const now = Date.now();
    if (now - (lastProviderErrorLog.get(key) || 0) < 60000) return;
    lastProviderErrorLog.set(key, now);
    logSafeError(`[invoice-check] ${key} status check failed:`, err);
}

/**
 * InvoiceChecker — Single Source of Truth for Payment Status Polling
 *
 * DRY FIX (BUG-003): Eliminates copy-pasted status-check logic that existed in:
 *   1. server.js  setInterval polling loop (every 10s)
 *   2. routes/pay.js  GET /api/pay/invoice/:id/status handler
 *
 * Both callers now import InvoiceChecker.check(payment) instead.
 */
class InvoiceChecker {
    /**
     * Check whether a pending payment has settled on its configured gateway.
     *
     * @param {object} payment - Row from `payments` table joined with reseller columns
     * @returns {Promise<{paid: boolean, expired?: boolean}>}
     */
    static async check(payment) {
        try {
            const provider = payment.provider || payment.wallet_type;
            const missing = message => ({ paid: false, credentialError: true, error: message });
            // ── Blink ────────────────────────────────────────────────────────
            if (provider === 'blink' && (payment.blink_api_key || payment.blink_api_keys) && payment.invoice_id) {
                const result = await BlinkService.checkInvoice({
                    apiKey:      payment.blink_api_key,
                    apiKeys:     payment.blink_api_keys,
                    paymentHash: payment.invoice_id
                });
                return { paid: result.paid === true, expired: result.expired === true, error: result.error || null };
            }
            if (provider === 'blink') return missing('Blink API key is missing. Re-enter it in Wallet Settings.');

            // ── LNbits ───────────────────────────────────────────────────────
            if (provider === 'lnbits' && payment.lnbits_invoice_key && payment.invoice_id) {
                const result = await LNbitsService.checkInvoice({
                    url:         payment.lnbits_url,
                    invoiceKey:  payment.lnbits_invoice_key,
                    paymentHash: payment.invoice_id
                });
                return { paid: result.paid === true };
            }
            if (provider === 'lnbits') return missing('LNbits Invoice Key is missing. Re-enter it in Wallet Settings.');

            // ── OpenNode ─────────────────────────────────────────────────────
            if (provider === 'opennode' && payment.invoice_id) {
                if (!payment.opennode_api_key) return missing('OpenNode API key is missing. Re-enter it in Wallet Settings.');
                const base = payment.opennode_env === 'dev'
                    ? 'https://dev-api.opennode.com'
                    : 'https://api.opennode.com';
                const resp = await axios.get(
                    `${base}/v1/charges/${payment.invoice_id}`,
                    { headers: { Authorization: payment.opennode_api_key }, timeout: 4000 }
                );
                const s = resp.data?.data?.status;
                if (s === 'paid')    return { paid: true };
                if (s === 'expired') return { paid: false, expired: true };
                return { paid: false };
            }

            if (provider === 'btcpay' && payment.invoice_id) {
                if (!payment.btcpay_url || !payment.btcpay_api_key) return missing('BTCPay credentials are missing. Re-enter them in Wallet Settings.');
                const resp = await axios.get(`${String(payment.btcpay_url).replace(/\/+$/, '')}/api/v1/invoices/${encodeURIComponent(payment.invoice_id)}`, {
                    headers: { Authorization: `token ${payment.btcpay_api_key}` }, timeout: 7000
                });
                const state = String(resp.data?.status || '').toLowerCase();
                return { paid: state === 'settled', expired: state === 'expired' || state === 'invalid' };
            }

            if (provider === 'alby' && payment.alby_access_token && payment.invoice_id) {
                const result = await AlbyService.checkInvoice({ accessToken: payment.alby_access_token, paymentHash: payment.invoice_id });
                return { paid: result.paid === true };
            }
            if (provider === 'alby') return missing('This Alby payment cannot be checked automatically. Re-enter an Alby Access Token or confirm receipt manually.');

            // ── Generic verify_url (LNURL-pay confirm endpoint) ───────────────
            if (payment.verify_url) {
                const resp = await axios.get(payment.verify_url, { timeout: 3000 });
                const d = resp.data;
                if (d && (d.settled === true || d.status === 'PAID')) {
                    return { paid: true };
                }
                return { paid: false };
            }
        } catch (err) {
            // Preserve pending state during transient provider failures, but log a
            // redacted diagnostic once per provider/minute so failures are visible.
            logProviderCheckError(payment?.provider || payment?.wallet_type, err);
            return { paid: false, error: 'Payment provider status check failed' };
        }

        return { paid: false };
    }
}

module.exports = InvoiceChecker;
