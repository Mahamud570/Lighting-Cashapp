const axios = require('axios');
const crypto = require('crypto');

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
            const status = err.response?.status;
            // Never retry 401/403 or client parameter errors, unless it's clock drift (-1021) which is handled specifically
            if (status && status >= 400 && status < 500 && status !== 429) {
                const code = err.response?.data?.code;
                if (code !== -1021) {
                    break;
                }
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
 * Binance API Service
 * Handles HMAC-SHA256 authentication, automatic server clock drift synchronization (-1021 protection),
 * exact 8-decimal Bitcoin string formatting, and Lightning deposit invoice generation.
 */
class BinanceService {
    static BASE_URL = 'https://api.binance.com';
    static timeOffset = 0;
    static lastTimeSync = 0;

    /**
     * Synchronize local system timestamp with Binance server clock
     */
    static async syncTime() {
        try {
            const startTime = Date.now();
            const resp = await axios.get(`${this.BASE_URL}/api/v3/time`, { timeout: 5000 });
            const endTime = Date.now();
            const latency = Math.round((endTime - startTime) / 2);

            if (resp.data && resp.data.serverTime) {
                this.timeOffset = (resp.data.serverTime + latency) - endTime;
                this.lastTimeSync = Date.now();
            }
        } catch (e) {
            // Keep existing offset on network errors
        }
    }

    /**
     * Get synchronized timestamp in milliseconds
     */
    static async getTimestamp() {
        if (!this.lastTimeSync || Date.now() - this.lastTimeSync > 300000) { // Re-sync every 5 minutes
            await this.syncTime();
        }
        return Date.now() + this.timeOffset;
    }

    /**
     * Generate HMAC-SHA256 signature for Binance query string
     */
    static sign(queryString, secret) {
        return crypto.createHmac('sha256', secret.trim()).update(queryString).digest('hex');
    }

    /**
     * Execute a signed Binance request with automatic clock drift recovery (-1021)
     */
    static async executeSignedRequest(method, endpoint, params, apiKey, apiSecret) {
        const makeRequest = async () => {
            const timestamp = await this.getTimestamp();
            const mergedParams = {
                ...params,
                recvWindow: 60000,
                timestamp
            };

            const queryString = Object.keys(mergedParams)
                .map(k => `${k}=${encodeURIComponent(mergedParams[k])}`)
                .join('&');

            const signature = this.sign(queryString, apiSecret);
            const url = `${this.BASE_URL}${endpoint}?${queryString}&signature=${signature}`;

            try {
                return await axios({
                    method,
                    url,
                    headers: {
                        'X-MBX-APIKEY': apiKey.trim(),
                        'Accept': 'application/json'
                    },
                    timeout: 12000
                });
            } catch (err) {
                // If Binance returns -1021 (Timestamp outside recvWindow), immediately re-sync clock and retry
                if (err.response?.data?.code === -1021) {
                    await this.syncTime();
                    throw err; // will trigger retry in withRetry
                }
                throw err;
            }
        };

        return withRetry(makeRequest, 3, 500);
    }

    /**
     * Test Binance API credentials and check BTC wallet permission
     */
    static async testConnection({ apiKey, apiSecret }) {
        if (!apiKey || !apiSecret) throw new Error('Binance API Key and Secret are required.');

        const resp = await this.executeSignedRequest(
            'GET',
            '/api/v3/account',
            {},
            apiKey,
            apiSecret
        );

        const btcAsset = resp.data?.balances?.find(b => b.asset === 'BTC');
        const usdtAsset = resp.data?.balances?.find(b => b.asset === 'USDT');

        return {
            canTrade: !!resp.data?.canTrade,
            canDeposit: !!resp.data?.canDeposit,
            canWithdraw: !!resp.data?.canWithdraw,
            btc_free: btcAsset?.free || '0.00000000',
            usdt_free: usdtAsset?.free || '0.00'
        };
    }

    /**
     * Request a Binance Bitcoin Lightning (or On-Chain) deposit address/invoice
     * @param {Object} opts
     * @param {string} opts.apiKey
     * @param {string} opts.apiSecret
     * @param {number|string} opts.amountSats - Amount in satoshis to sweep
     * @param {string} [opts.network='LIGHTNING'] - 'LIGHTNING' or 'BTC'
     */
    static async getDepositInvoice({ apiKey, apiSecret, amountSats, network = 'LIGHTNING' }) {
        if (!apiKey || !apiSecret) throw new Error('Binance API credentials are required.');

        const sats = parseInt(amountSats, 10);
        if (isNaN(sats) || sats <= 0) {
            throw new Error(`Invalid satoshi amount: ${amountSats}. Must be a positive integer.`);
        }

        // Exact 8-decimal Bitcoin string formatting (e.g. 10000 sats -> "0.00010000")
        const btcAmount = (sats / 100000000).toFixed(8);

        const params = {
            coin: 'BTC',
            network: network === 'onchain' ? 'BTC' : 'LIGHTNING'
        };

        if (network !== 'onchain') {
            params.amount = btcAmount;
        }

        const resp = await this.executeSignedRequest(
            'GET',
            '/sapi/v1/capital/deposit/address',
            params,
            apiKey,
            apiSecret
        );

        if (!resp.data || !resp.data.address) {
            throw new Error('Binance did not return a valid deposit address/invoice.');
        }

        return {
            coin: resp.data.coin || 'BTC',
            address: resp.data.address, // BOLT11 invoice (lnbc...) if LIGHTNING
            tag: resp.data.tag || '',
            network: resp.data.network || network,
            amount_btc: btcAmount,
            amount_sats: sats
        };
    }

    /**
     * Check deposit history on Binance to verify deposit status
     */
    static async getDepositHistory({ apiKey, apiSecret, startTime }) {
        if (!apiKey || !apiSecret) throw new Error('Binance API credentials are required.');

        const params = { coin: 'BTC' };
        if (startTime) params.startTime = startTime;

        const resp = await this.executeSignedRequest(
            'GET',
            '/sapi/v1/capital/deposit/hisrec',
            params,
            apiKey,
            apiSecret
        );

        return resp.data;
    }
}

module.exports = BinanceService;
