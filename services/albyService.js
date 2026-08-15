const axios = require('axios');

/**
 * Alby & Nostr Wallet Connect (NWC) API Service
 * Official API: https://api.getalby.com
 */
class AlbyService {
    static BASE_URL = 'https://api.getalby.com';

    /**
     * Parse Nostr Wallet Connect (NWC) connection string
     * Format: nostr+walletconnect://<pubkey>?relay=<relay>&secret=<secret>&lud16=<lud16>
     */
    static parseNwcUri(nwcString) {
        if (!nwcString) return null;
        try {
            const url = new URL(nwcString.replace('nostr+walletconnect://', 'https://placeholder.local/'));
            return {
                pubkey: url.hostname !== 'placeholder.local' ? url.hostname : url.pathname.replace(/^\//, ''),
                relay: url.searchParams.get('relay'),
                secret: url.searchParams.get('secret'),
                lud16: url.searchParams.get('lud16')
            };
        } catch (e) {
            return null;
        }
    }

    /**
     * Get account details & balance using Alby Access Token or NWC
     */
    static async getAccountDetails({ accessToken, nwcString }) {
        if (accessToken) {
            const resp = await axios.get(`${this.BASE_URL}/user/value`, {
                headers: { Authorization: `Bearer ${accessToken}` },
                timeout: 5000
            });
            const meResp = await axios.get(`${this.BASE_URL}/user/me`, {
                headers: { Authorization: `Bearer ${accessToken}` },
                timeout: 5000
            });
            return {
                lightning_address: meResp.data?.lightning_address,
                email: meResp.data?.email,
                balance_sats: resp.data?.balance || 0,
                currency: resp.data?.currency || 'USD'
            };
        }

        const parsed = this.parseNwcUri(nwcString);
        if (parsed) {
            return {
                lightning_address: parsed.lud16 || 'NWC Connected Wallet',
                relay: parsed.relay,
                balance_sats: 'Dynamic (NWC)',
                is_nwc: true
            };
        }

        throw new Error('Alby Access Token or NWC connection string required');
    }

    /**
     * Create an incoming Lightning invoice using Alby API
     */
    static async createInvoice({ accessToken, amountSats, memo }) {
        if (!accessToken) {
            throw new Error('Alby Access Token required to generate invoice via Alby API');
        }

        const resp = await axios.post(`${this.BASE_URL}/invoices`, {
            amount: amountSats,
            memo: memo || 'Cash App Lightning Payment'
        }, {
            headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            },
            timeout: 7000
        });

        return {
            payment_request: resp.data.payment_request,
            payment_hash: resp.data.payment_hash,
            expires_at: resp.data.expires_at
        };
    }

    /**
     * Pay an outbound BOLT11 invoice using Alby API (for instant payouts & sweeps)
     */
    static async payInvoice({ accessToken, bolt11 }) {
        if (!accessToken) {
            throw new Error('Alby Access Token required to pay outbound invoices');
        }

        const resp = await axios.post(`${this.BASE_URL}/payments/bolt11`, {
            invoice: bolt11.trim()
        }, {
            headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            },
            timeout: 15000
        });

        return {
            preimage: resp.data.payment_preimage,
            payment_hash: resp.data.payment_hash,
            fee_sats: resp.data.fee ? Math.ceil(resp.data.fee / 1000) : 0,
            status: 'paid'
        };
    }
}

module.exports = AlbyService;
