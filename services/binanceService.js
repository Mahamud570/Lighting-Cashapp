const axios = require('axios');
const crypto = require('crypto');

/**
 * Binance API Service
 * Handles Binance API authentication (HMAC-SHA256), automatic server time sync,
 * balance fetching, and generating dynamic Bitcoin Lightning deposit invoices for auto-sweeping.
 */
class BinanceService {
    static BASE_URL = 'https://api.binance.com';
    static timeOffset = 0;
    static lastTimeSync = 0;

    /**
     * Synchronize local timestamp with Binance server clock
     */
    static async syncTime() {
        try {
            const resp = await axios.get(`${this.BASE_URL}/api/v3/time`, { timeout: 3000 });
            if (resp.data && resp.data.serverTime) {
                this.timeOffset = resp.data.serverTime - Date.now();
                this.lastTimeSync = Date.now();
            }
        } catch (e) {
            // Keep existing offset
        }
    }

    /**
     * Get synchronized timestamp
     */
    static async getTimestamp() {
        if (!this.lastTimeSync || Date.now() - this.lastTimeSync > 300000) { // re-sync every 5 min
            await this.syncTime();
        }
        return Date.now() + this.timeOffset;
    }

    /**
     * Generate HMAC-SHA256 signature for Binance query string
     */
    static sign(queryString, secret) {
        return crypto.createHmac('sha256', secret).update(queryString).digest('hex');
    }

    /**
     * Test Binance API credentials and check BTC wallet permission
     */
    static async testConnection({ apiKey, apiSecret }) {
        if (!apiKey || !apiSecret) throw new Error('Binance API Key and Secret are required');

        await this.syncTime();
        const timestamp = await this.getTimestamp();
        const queryString = `recvWindow=60000&timestamp=${timestamp}`;
        const signature = this.sign(queryString, apiSecret.trim());

        const resp = await axios.get(`${this.BASE_URL}/api/v3/account?${queryString}&signature=${signature}`, {
            headers: {
                'X-MBX-APIKEY': apiKey.trim()
            },
            timeout: 8000
        });

        const btcAsset = resp.data?.balances?.find(b => b.asset === 'BTC');
        const usdtAsset = resp.data?.balances?.find(b => b.asset === 'USDT');

        return {
            canTrade: resp.data?.canTrade,
            canDeposit: resp.data?.canDeposit,
            canWithdraw: resp.data?.canWithdraw,
            btc_free: btcAsset?.free || '0.00000000',
            usdt_free: usdtAsset?.free || '0.00'
        };
    }

    /**
     * Request a Binance Bitcoin Lightning (or On-Chain) deposit address/invoice
     * @param {Object} opts
     * @param {string} opts.apiKey
     * @param {string} opts.apiSecret
     * @param {number} opts.amountSats - Amount in satoshis to sweep
     * @param {string} opts.network - 'LIGHTNING' or 'BTC'
     */
    static async getDepositInvoice({ apiKey, apiSecret, amountSats, network = 'LIGHTNING' }) {
        if (!apiKey || !apiSecret) throw new Error('Binance API credentials missing');

        await this.syncTime();
        const timestamp = await this.getTimestamp();
        const btcAmount = (amountSats / 100000000).toFixed(8);

        let paramsObj = {
            coin: 'BTC',
            network: network === 'onchain' ? 'BTC' : 'LIGHTNING',
            recvWindow: 60000,
            timestamp
        };

        if (network !== 'onchain' && amountSats) {
            paramsObj.amount = btcAmount;
        }

        const queryString = Object.keys(paramsObj)
            .map(k => `${k}=${encodeURIComponent(paramsObj[k])}`)
            .join('&');

        const signature = this.sign(queryString, apiSecret.trim());

        const resp = await axios.get(
            `${this.BASE_URL}/sapi/v1/capital/deposit/address?${queryString}&signature=${signature}`,
            {
                headers: {
                    'X-MBX-APIKEY': apiKey.trim()
                },
                timeout: 10000
            }
        );

        // For Lightning network, resp.data.address contains the BOLT11 lightning invoice (lnbc...)
        return {
            coin: resp.data.coin,
            address: resp.data.address, // BOLT11 invoice if LIGHTNING
            tag: resp.data.tag,
            network: resp.data.network || network,
            amount_btc: btcAmount,
            amount_sats: amountSats
        };
    }

    /**
     * Check deposit history on Binance to verify deposit status
     */
    static async getDepositHistory({ apiKey, apiSecret, startTime }) {
        await this.syncTime();
        const timestamp = await this.getTimestamp();
        let params = `coin=BTC&recvWindow=60000&timestamp=${timestamp}`;
        if (startTime) params += `&startTime=${startTime}`;
        const signature = this.sign(params, apiSecret.trim());

        const resp = await axios.get(
            `${this.BASE_URL}/sapi/v1/capital/deposit/hisrec?${params}&signature=${signature}`,
            {
                headers: { 'X-MBX-APIKEY': apiKey.trim() },
                timeout: 7000
            }
        );

        return resp.data; // List of deposit records
    }
}

module.exports = BinanceService;
