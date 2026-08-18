const axios = require('axios');

/**
 * Helper to perform async retry with exponential backoff
 */
async function withRetry(fn, retries = 3, delayMs = 500) {
    let lastError;
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            lastError = err;
            // Do not retry 4xx client errors (e.g. invalid API key, insufficient funds, invalid bolt11)
            const status = err.response?.status;
            if (status && status >= 400 && status < 500 && status !== 429) {
                break;
            }
            if (attempt < retries) {
                const backoff = delayMs * Math.pow(2, attempt - 1);
                await new Promise(r => setTimeout(r, backoff));
            }
        }
    }
    throw lastError;
}

/**
 * LNbits API Service
 * Production-grade client with exponential backoff, integer arithmetic, and defensive error handling.
 */
class LNbitsService {
    /**
     * Clean and normalize base URL
     */
    static normalizeUrl(url) {
        if (!url || typeof url !== 'string') return 'https://legend.lnbits.com';
        return url.trim().replace(/\/+$/, '');
    }

    /**
     * Test connection & fetch wallet details
     * @param {Object} params
     * @param {string} params.url - LNbits base URL
     * @param {string} params.invoiceKey - LNbits Invoice Key or Admin Key
     */
    static async getWalletDetails({ url, invoiceKey }) {
        if (!invoiceKey) {
            throw new Error('LNbits Invoice Key is required to fetch wallet details.');
        }

        const baseUrl = this.normalizeUrl(url);
        return withRetry(async () => {
            const resp = await axios.get(`${baseUrl}/api/v1/wallet`, {
                headers: {
                    'X-Api-Key': invoiceKey.trim(),
                    'Accept': 'application/json'
                },
                timeout: 8000
            });

            if (!resp.data || typeof resp.data !== 'object') {
                throw new Error('Invalid JSON response received from LNbits.');
            }

            const balanceMsat = parseInt(resp.data.balance, 10) || 0;
            const balanceSats = Math.floor(balanceMsat / 1000);

            return {
                name: resp.data.name || 'LNbits Wallet',
                balance_msat: balanceMsat,
                balance_sats: balanceSats
            };
        });
    }

    /**
     * Create an incoming Lightning invoice
     * @param {Object} params
     * @param {string} params.url
     * @param {string} params.invoiceKey
     * @param {number|string} params.amountSats - Amount in satoshis (integer)
     * @param {string} [params.memo]
     * @param {string} [params.webhookUrl]
     */
    static async createInvoice({ url, invoiceKey, amountSats, memo, webhookUrl }) {
        if (!invoiceKey) {
            throw new Error('LNbits Invoice Key is required to create an invoice.');
        }

        const sats = parseInt(amountSats, 10);
        if (isNaN(sats) || sats <= 0) {
            throw new Error(`Invalid amount in satoshis: ${amountSats}. Must be a positive integer.`);
        }

        const baseUrl = this.normalizeUrl(url);
        const payload = {
            out: false,
            amount: sats,
            memo: memo ? String(memo).substring(0, 200) : 'Lightning Payment',
            webhook: webhookUrl || undefined
        };

        try {
            return await withRetry(async () => {
                const resp = await axios.post(`${baseUrl}/api/v1/payments`, payload, {
                    headers: {
                        'X-Api-Key': invoiceKey.trim(),
                        'Content-Type': 'application/json',
                        'Accept': 'application/json'
                    },
                    timeout: 10000
                });

                if (!resp.data || (!resp.data.payment_hash && !resp.data.payment_request)) {
                    throw new Error('LNbits did not return a valid payment request.');
                }

                return {
                    payment_hash: resp.data.payment_hash,
                    payment_request: resp.data.payment_request,
                    checking_id: resp.data.checking_id,
                    lnurl_response: resp.data.lnurl_response || null
                };
            });
        } catch (err) {
            // Fallback retry without webhook parameter if rejected by LNbits instance
            if (payload.webhook) {
                delete payload.webhook;
                try {
                    const resp = await axios.post(`${baseUrl}/api/v1/payments`, payload, {
                        headers: {
                            'X-Api-Key': invoiceKey.trim(),
                            'Content-Type': 'application/json',
                            'Accept': 'application/json'
                        },
                        timeout: 10000
                    });
                    if (resp.data && (resp.data.payment_hash || resp.data.payment_request)) {
                        return {
                            payment_hash: resp.data.payment_hash,
                            payment_request: resp.data.payment_request,
                            checking_id: resp.data.checking_id,
                            lnurl_response: resp.data.lnurl_response || null
                        };
                    }
                } catch (_) {}
            }
            throw err;
        }
    }

    /**
     * Check invoice status by payment hash
     * @param {Object} params
     * @param {string} params.url
     * @param {string} params.invoiceKey
     * @param {string} params.paymentHash
     */
    static async checkInvoice({ url, invoiceKey, paymentHash }) {
        if (!invoiceKey || !paymentHash) {
            throw new Error('Invoice key and payment hash are required to check status.');
        }

        const baseUrl = this.normalizeUrl(url);
        return withRetry(async () => {
            const resp = await axios.get(`${baseUrl}/api/v1/payments/${encodeURIComponent(paymentHash.trim())}`, {
                headers: {
                    'X-Api-Key': invoiceKey.trim(),
                    'Accept': 'application/json'
                },
                timeout: 8000
            });

            const data = resp.data || {};
            return {
                paid: data.paid === true,
                preimage: data.preimage || null,
                details: data.details || null
            };
        });
    }

    /**
     * Pay an outbound BOLT11 invoice using Admin Key (for automated sweeping & instant settlements)
     * @param {Object} params
     * @param {string} params.url
     * @param {string} params.adminKey
     * @param {string} params.bolt11 - BOLT11 payment request
     */
    static async payInvoice({ url, adminKey, bolt11 }) {
        if (!adminKey) {
            throw new Error('LNbits Admin Key is required to execute outbound payments.');
        }
        if (!bolt11 || typeof bolt11 !== 'string' || !bolt11.toLowerCase().startsWith('lnbc')) {
            throw new Error('Invalid BOLT11 Lightning invoice format.');
        }

        const baseUrl = this.normalizeUrl(url);
        return withRetry(async () => {
            const resp = await axios.post(`${baseUrl}/api/v1/payments`, {
                out: true,
                bolt11: bolt11.trim()
            }, {
                headers: {
                    'X-Api-Key': adminKey.trim(),
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                timeout: 25000 // Outbound payments may take longer for routing
            });

            const data = resp.data || {};
            const feeMsat = parseInt(data.fee_msat, 10) || 0;
            const feeSats = Math.ceil(feeMsat / 1000);

            return {
                payment_hash: data.payment_hash || null,
                checking_id: data.checking_id || data.payment_hash || null,
                preimage: data.preimage || null,
                fee_sats: feeSats
            };
        }, 2, 1000); // 2 retries for payments
    }
}

module.exports = LNbitsService;
