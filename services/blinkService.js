const axios = require('axios');

/**
 * Blink (Bitcoin Beach) GraphQL API Service
 * Official API: https://api.blink.sv/graphql
 */
class BlinkService {
    static GRAPHQL_URL = 'https://api.blink.sv/graphql';

    /**
     * Execute a GraphQL query or mutation against Blink API
     */
    static async request(apiKey, query, variables = {}, timeout = 10000) {
        const resp = await axios.post(
            this.GRAPHQL_URL,
            { query, variables },
            {
                headers: {
                    'X-API-KEY': apiKey,
                    'Content-Type': 'application/json'
                },
                timeout
            }
        );

        if (resp.data.errors && resp.data.errors.length > 0) {
            throw new Error(resp.data.errors.map(e => e.message).join(', '));
        }

        return resp.data.data;
    }

    /**
     * Get user account and wallet details (BTC wallet ID & balance)
     */
    static async getWalletDetails({ apiKey }) {
        const query = `
            query Me {
                me {
                    id
                    username
                    defaultAccount {
                        id
                        wallets {
                            id
                            walletCurrency
                            balance
                        }
                    }
                }
            }
        `;

        const data = await this.request(apiKey, query);
        const me = data?.me;
        const btcWallet = me?.defaultAccount?.wallets?.find(w => w.walletCurrency === 'BTC') || me?.defaultAccount?.wallets?.[0];

        return {
            username: me?.username || me?.id,
            wallet_id: btcWallet?.id,
            currency: btcWallet?.walletCurrency,
            balance_sats: btcWallet?.balance || 0,
            wallets: me?.defaultAccount?.wallets || []
        };
    }

    /**
     * Parse single or multiple Blink API keys into a clean array
     */
    static parseApiKeys(apiKey, apiKeys) {
        const keys = [];
        if (Array.isArray(apiKeys)) {
            keys.push(...apiKeys);
        } else if (typeof apiKeys === 'string' && apiKeys.trim()) {
            try {
                const parsed = JSON.parse(apiKeys);
                if (Array.isArray(parsed)) keys.push(...parsed);
                else keys.push(apiKeys);
            } catch (_) {
                // Comma or newline separated fallback
                keys.push(...apiKeys.split(/[\n,]+/).map(k => k.trim()).filter(Boolean));
            }
        }
        if (apiKey && typeof apiKey === 'string' && apiKey.trim() && !keys.includes(apiKey.trim())) {
            keys.unshift(apiKey.trim());
        }
        return keys.filter(Boolean);
    }

    /**
     * Create an incoming Lightning invoice in BTC wallet.
     * Supports Multi-Key Pool (`apiKeys` array) to bypass the $1,000 single-wallet limit.
     */
    static async createInvoice({ apiKey, apiKeys, walletId, amountSats, memo }) {
        const keys = this.parseApiKeys(apiKey, apiKeys);
        if (!keys.length) {
            throw new Error('No Blink API key provided');
        }

        let lastErr = null;
        for (const key of keys) {
            try {
                // Resolve walletId for current key if needed
                let targetWalletId = walletId;
                if (!targetWalletId) {
                    const details = await this.getWalletDetails({ apiKey: key });
                    targetWalletId = details.wallet_id;
                }

                const query = `
                    mutation LnInvoiceCreate($input: LnInvoiceCreateInput!) {
                        lnInvoiceCreate(input: $input) {
                            errors {
                                message
                                code
                            }
                            invoice {
                                paymentRequest
                                paymentHash
                                paymentSecret
                                satoshis
                            }
                        }
                    }
                `;

                const variables = {
                    input: {
                        walletId: targetWalletId,
                        amount: amountSats,
                        memo: memo || 'Cash App Lightning Payment'
                    }
                };

                const data = await this.request(key, query, variables);
                const res = data.lnInvoiceCreate;

                if (res.errors && res.errors.length > 0) {
                    throw new Error(res.errors.map(e => e.message).join(', '));
                }

                return {
                    payment_request: res.invoice.paymentRequest,
                    payment_hash:    res.invoice.paymentHash,
                    payment_secret:  res.invoice.paymentSecret,
                    satoshis:        res.invoice.satoshis,
                    used_key:        key
                };
            } catch (err) {
                console.warn(`[BlinkService] Key attempt failed (${err.message}). Trying next key in pool if available...`);
                lastErr = err;
            }
        }

        throw lastErr || new Error('All Blink API keys in pool failed to generate invoice');
    }

    /**
     * Pay an outbound BOLT11 invoice (for instant payouts & sweeps)
     */
    static async payInvoice({ apiKey, walletId, paymentRequest, memo }) {
        let targetWalletId = walletId;
        if (!targetWalletId) {
            const details = await this.getWalletDetails({ apiKey });
            targetWalletId = details.wallet_id;
        }

        const query = `
            mutation LnInvoicePaymentSend($input: LnInvoicePaymentInput!) {
                lnInvoicePaymentSend(input: $input) {
                    errors {
                        message
                        code
                    }
                    status
                    transaction {
                        id
                        settlementAmount
                        settlementFee
                    }
                }
            }
        `;

        const variables = {
            input: {
                walletId: targetWalletId,
                paymentRequest: paymentRequest.trim(),
                memo: memo || 'Auto-payout settlement'
            }
        };

        const data = await this.request(apiKey, query, variables, 30000);
        const res = data.lnInvoicePaymentSend;

        if (res.errors && res.errors.length > 0) {
            throw new Error(res.errors.map(e => e.message).join(', '));
        }

        return {
            status: res.status,
            transaction_id: res.transaction?.id,
            fee_sats: res.transaction?.settlementFee || 0
        };
    }

    /**
     * Check if an invoice payment has settled in Blink.
     * Supports Multi-Key Pool (`apiKeys` array).
     */
    static async checkInvoice({ apiKey, apiKeys, paymentHash }) {
        const keys = this.parseApiKeys(apiKey, apiKeys);
        if (!keys.length) return { paid: false };

        const query = `
            query CheckInvoice($paymentHash: PaymentHash!) {
                me {
                    defaultAccount {
                        wallets {
                            id
                            walletCurrency
                            transactions(first: 100) {
                                edges {
                                    node {
                                        id
                                        status
                                        settlementAmount
                                        initiationVia {
                                            ... on InitiationViaLn {
                                                paymentHash
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        `;

        for (const key of keys) {
            try {
                const data = await this.request(key, query, { paymentHash });
                const wallets = data?.me?.defaultAccount?.wallets || [];

                for (const w of wallets) {
                    const edges = w.transactions?.edges || [];
                    const match = edges.find(
                        e => e.node?.initiationVia?.paymentHash === paymentHash &&
                             e.node?.status === 'SUCCESS'
                    );
                    if (match) {
                        return {
                            paid:        true,
                            amount_sats: match.node.settlementAmount,
                            txid:        match.node.id,
                            used_key:    key
                        };
                    }
                }
            } catch (err) {
                // Key error, try next key in pool
            }
        }

        return { paid: false };
    }
}

module.exports = BlinkService;


