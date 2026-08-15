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
    static async request(apiKey, query, variables = {}) {
        const resp = await axios.post(
            this.GRAPHQL_URL,
            { query, variables },
            {
                headers: {
                    'X-API-KEY': apiKey,
                    'Content-Type': 'application/json'
                },
                timeout: 10000
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
     * Create an incoming Lightning invoice in BTC wallet
     */
    static async createInvoice({ apiKey, walletId, amountSats, memo }) {
        // If walletId wasn't passed, resolve it first
        let targetWalletId = walletId;
        if (!targetWalletId) {
            const details = await this.getWalletDetails({ apiKey });
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

        const data = await this.request(apiKey, query, variables);
        const res = data.lnInvoiceCreate;

        if (res.errors && res.errors.length > 0) {
            throw new Error(res.errors.map(e => e.message).join(', '));
        }

        return {
            payment_request: res.invoice.paymentRequest,
            payment_hash: res.invoice.paymentHash,
            satoshis: res.invoice.satoshis
        };
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

        const data = await this.request(apiKey, query, variables);
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
     * Check if an invoice payment has settled in Blink
     */
    static async checkInvoice({ apiKey, paymentHash }) {
        try {
            const query = `
                query Me {
                    me {
                        defaultAccount {
                            wallets {
                                id
                                walletCurrency
                                balance
                                transactions(first: 25) {
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

            const data = await this.request(apiKey, query);
            const wallets = data?.me?.defaultAccount?.wallets || [];
            for (const w of wallets) {
                const edges = w.transactions?.edges || [];
                const match = edges.find(e => e.node?.initiationVia?.paymentHash === paymentHash && e.node?.status === 'SUCCESS');
                if (match) {
                    return {
                        paid: true,
                        amount_sats: match.node.settlementAmount,
                        txid: match.node.id
                    };
                }
            }

            return { paid: false };
        } catch (err) {
            return { paid: false };
        }
    }
}

module.exports = BlinkService;
