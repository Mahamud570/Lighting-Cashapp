const axios = require('axios');
const LNbitsService = require('./lnbitsService');
const BlinkService  = require('./blinkService');

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
            // ── Blink ────────────────────────────────────────────────────────
            if (payment.wallet_type === 'blink' && (payment.blink_api_key || payment.blink_api_keys) && payment.invoice_id) {
                const result = await BlinkService.checkInvoice({
                    apiKey:      payment.blink_api_key,
                    apiKeys:     payment.blink_api_keys,
                    paymentHash: payment.invoice_id
                });
                return { paid: result.paid === true };
            }

            // ── LNbits ───────────────────────────────────────────────────────
            if (payment.wallet_type === 'lnbits' && payment.lnbits_invoice_key && payment.invoice_id) {
                const result = await LNbitsService.checkInvoice({
                    url:         payment.lnbits_url,
                    invoiceKey:  payment.lnbits_invoice_key,
                    paymentHash: payment.invoice_id
                });
                return { paid: result.paid === true };
            }

            // ── OpenNode ─────────────────────────────────────────────────────
            if (payment.wallet_type === 'opennode' && payment.invoice_id) {
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

            // ── Generic verify_url (LNURL-pay confirm endpoint) ───────────────
            if (payment.verify_url) {
                const resp = await axios.get(payment.verify_url, { timeout: 3000 });
                const d = resp.data;
                if (d && (d.settled === true || d.status === 'PAID')) {
                    return { paid: true };
                }
                return { paid: false };
            }
        } catch (_) {
            // Network/API errors treated as not-yet-paid; polling loop will retry.
        }

        return { paid: false };
    }
}

module.exports = InvoiceChecker;
