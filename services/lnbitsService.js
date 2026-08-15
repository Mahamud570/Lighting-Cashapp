const axios = require('axios');

/**
 * LNbits API Service
 * Supports invoice generation, payment polling, instant webhooks, and outbound payments via Admin Key.
 */
class LNbitsService {
    /**
     * Clean and normalize base URL
     */
    static normalizeUrl(url) {
        if (!url) return 'https://legend.lnbits.com';
        return url.replace(/\/+$/, '');
    }

    /**
     * Test connection & fetch wallet details
     */
    static async getWalletDetails({ url, invoiceKey }) {
        const baseUrl = this.normalizeUrl(url);
        const resp = await axios.get(`${baseUrl}/api/v1/wallet`, {
            headers: { 'X-Api-Key': invoiceKey },
            timeout: 5000
        });
        return {
            name: resp.data.name,
            balance_msat: resp.data.balance,
            balance_sats: Math.floor(resp.data.balance / 1000)
        };
    }

    /**
     * Create an incoming Lightning invoice
     */
    static async createInvoice({ url, invoiceKey, amountSats, memo, webhookUrl }) {
        const baseUrl = this.normalizeUrl(url);
        const payload = {
            out: false,
            amount: amountSats,
            memo: memo || 'Cash App Lightning Payment',
            webhook: webhookUrl || undefined
        };

        const resp = await axios.post(`${baseUrl}/api/v1/payments`, payload, {
            headers: {
                'X-Api-Key': invoiceKey,
                'Content-Type': 'application/json'
            },
            timeout: 7000
        });

        return {
            payment_hash: resp.data.payment_hash,
            payment_request: resp.data.payment_request,
            checking_id: resp.data.checking_id,
            lnurl_response: resp.data.lnurl_response
        };
    }

    /**
     * Check invoice status
     */
    static async checkInvoice({ url, invoiceKey, paymentHash }) {
        const baseUrl = this.normalizeUrl(url);
        const resp = await axios.get(`${baseUrl}/api/v1/payments/${paymentHash}`, {
            headers: { 'X-Api-Key': invoiceKey },
            timeout: 5000
        });

        return {
            paid: resp.data.paid === true,
            preimage: resp.data.preimage,
            details: resp.data.details
        };
    }

    /**
     * Pay an outbound BOLT11 invoice using Admin Key (for instant payouts & sweeps)
     */
    static async payInvoice({ url, adminKey, bolt11 }) {
        if (!adminKey) {
            throw new Error('LNbits Admin Key is required to execute outbound payments.');
        }

        const baseUrl = this.normalizeUrl(url);
        const resp = await axios.post(`${baseUrl}/api/v1/payments`, {
            out: true,
            bolt11: bolt11.trim()
        }, {
            headers: {
                'X-Api-Key': adminKey,
                'Content-Type': 'application/json'
            },
            timeout: 15000
        });

        return {
            payment_hash: resp.data.payment_hash,
            checking_id: resp.data.checking_id,
            preimage: resp.data.preimage || null,
            fee_sats: resp.data.fee_msat ? Math.ceil(resp.data.fee_msat / 1000) : 0
        };
    }
}

module.exports = LNbitsService;
