const express = require('express');
const router = express.Router();
const db = require('../database/db');
const auth = require('../middleware/auth');
const axios = require('axios');
const LNbitsService = require('../services/lnbitsService');
const BlinkService = require('../services/blinkService');
const AlbyService = require('../services/albyService');
const BinanceService = require('../services/binanceService');
const TelegramService = require('../services/telegramService');

// GET /api/wallet - retrieve all connected gateway configs and balances
router.get('/api/wallet', auth, async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM resellers WHERE id = ?', [req.reseller.id]);
        const r = rows[0] || req.reseller;

        res.json({
            wallet_type: r.wallet_type,
            wallet_email: r.wallet_email,
            // OpenNode
            opennode_api_key: r.opennode_api_key ? '***' + r.opennode_api_key.slice(-4) : null,
            opennode_env: r.opennode_env,
            // BTCPay
            btcpay_url: r.btcpay_url,
            btcpay_store_id: r.btcpay_store_id,
            btcpay_api_key: r.btcpay_api_key ? '***' + r.btcpay_api_key.slice(-4) : null,
            btcpay_webhook_id: r.btcpay_webhook_id,
            // LNbits
            lnbits_url: r.lnbits_url,
            lnbits_invoice_key: r.lnbits_invoice_key ? '***' + r.lnbits_invoice_key.slice(-4) : null,
            lnbits_admin_key: r.lnbits_admin_key ? '***' + r.lnbits_admin_key.slice(-4) : null,
            // Blink
            blink_api_key: r.blink_api_key ? '***' + r.blink_api_key.slice(-4) : null,
            blink_wallet_id: r.blink_wallet_id,
            // Alby / NWC
            alby_nwc_string: r.alby_nwc_string ? 'nostr+walletconnect://***' : null,
            alby_access_token: r.alby_access_token ? '***' + r.alby_access_token.slice(-4) : null,
            // Binance
            binance_api_key: r.binance_api_key ? '***' + r.binance_api_key.slice(-4) : null,
            binance_auto_sweep_enabled: !!r.binance_auto_sweep_enabled,
            binance_sweep_threshold_usd: r.binance_sweep_threshold_usd || 0,
            binance_sweep_type: r.binance_sweep_type || 'lightning',
            // Auto Payout
            auto_payout_enabled: !!r.auto_payout_enabled,
            auto_payout_address: r.auto_payout_address,
            auto_payout_percent: r.auto_payout_percent || 100,
            // Telegram Bot
            telegram_bot_token: r.telegram_bot_token ? '***' + r.telegram_bot_token.slice(-6) : null,
            telegram_chat_id: r.telegram_chat_id || '',
            status: r.wallet_type ? 'active' : 'inactive'
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/wallet/email - save email / lightning address
router.post('/api/wallet/email', auth, async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) return res.status(400).json({ error: 'Lightning Address required' });

        await db.query(
            'UPDATE resellers SET wallet_type = "email", wallet_email = ? WHERE id = ?',
            [email.trim(), req.reseller.id]
        );

        res.json({ success: true, message: 'Lightning Address saved' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/wallet/lnbits - save LNbits
router.post('/api/wallet/lnbits', auth, async (req, res) => {
    try {
        const { url, invoice_key, admin_key } = req.body;
        if (!invoice_key) return res.status(400).json({ error: 'LNbits Invoice/Read Key is required' });

        const targetUrl = url ? url.trim() : 'https://legend.lnbits.com';

        // Test connection
        await LNbitsService.getWalletDetails({ url: targetUrl, invoiceKey: invoice_key.trim() });

        await db.query(
            `UPDATE resellers SET wallet_type = "lnbits", lnbits_url = ?, lnbits_invoice_key = ?, lnbits_admin_key = ? WHERE id = ?`,
            [targetUrl, invoice_key.trim(), admin_key ? admin_key.trim() : null, req.reseller.id]
        );

        res.json({ success: true, message: 'LNbits wallet connected successfully' });
    } catch (err) {
        res.status(400).json({ error: 'LNbits Connection Failed: ' + (err.response?.data?.message || err.message) });
    }
});

// POST /api/wallet/lnbits/test
router.post('/api/wallet/lnbits/test', auth, async (req, res) => {
    try {
        const { url, invoice_key } = req.body;
        const targetUrl = url || req.reseller.lnbits_url || 'https://legend.lnbits.com';
        const key = invoice_key || req.reseller.lnbits_invoice_key;

        const details = await LNbitsService.getWalletDetails({ url: targetUrl, invoiceKey: key });
        res.json({ success: true, data: details });
    } catch (err) {
        res.status(400).json({ error: 'LNbits Test Failed: ' + (err.response?.data?.message || err.message) });
    }
});

// POST /api/wallet/blink - save Blink
router.post('/api/wallet/blink', auth, async (req, res) => {
    try {
        const { api_key, wallet_id } = req.body;
        if (!api_key) return res.status(400).json({ error: 'Blink API Key is required' });

        // Test connection and auto-detect wallet ID if not provided
        const details = await BlinkService.getWalletDetails({ apiKey: api_key.trim() });
        const finalWalletId = wallet_id ? wallet_id.trim() : details.wallet_id;

        await db.query(
            `UPDATE resellers SET wallet_type = "blink", blink_api_key = ?, blink_wallet_id = ? WHERE id = ?`,
            [api_key.trim(), finalWalletId, req.reseller.id]
        );

        res.json({ success: true, message: `Blink Connected (${details.username || details.wallet_id})`, data: details });
    } catch (err) {
        res.status(400).json({ error: 'Blink Connection Failed: ' + err.message });
    }
});

// POST /api/wallet/blink/test
router.post('/api/wallet/blink/test', auth, async (req, res) => {
    try {
        const { api_key } = req.body;
        const key = api_key || req.reseller.blink_api_key;
        const details = await BlinkService.getWalletDetails({ apiKey: key });
        res.json({ success: true, data: details });
    } catch (err) {
        res.status(400).json({ error: 'Blink Test Failed: ' + err.message });
    }
});

// POST /api/wallet/alby - save Alby / NWC
router.post('/api/wallet/alby', auth, async (req, res) => {
    try {
        const { access_token, nwc_string } = req.body;
        if (!access_token && !nwc_string) {
            return res.status(400).json({ error: 'Alby Access Token or NWC connection string required' });
        }

        const details = await AlbyService.getAccountDetails({
            accessToken: access_token ? access_token.trim() : null,
            nwcString: nwc_string ? nwc_string.trim() : null
        });

        await db.query(
            `UPDATE resellers SET wallet_type = "alby", alby_access_token = ?, alby_nwc_string = ? WHERE id = ?`,
            [access_token ? access_token.trim() : null, nwc_string ? nwc_string.trim() : null, req.reseller.id]
        );

        res.json({ success: true, message: 'Alby wallet connected successfully', data: details });
    } catch (err) {
        res.status(400).json({ error: 'Alby Connection Failed: ' + err.message });
    }
});

// POST /api/wallet/alby/test
router.post('/api/wallet/alby/test', auth, async (req, res) => {
    try {
        const { access_token, nwc_string } = req.body;
        const token = access_token || req.reseller.alby_access_token;
        const nwc = nwc_string || req.reseller.alby_nwc_string;

        const details = await AlbyService.getAccountDetails({ accessToken: token, nwcString: nwc });
        res.json({ success: true, data: details });
    } catch (err) {
        res.status(400).json({ error: 'Alby Test Failed: ' + err.message });
    }
});

// POST /api/wallet/opennode
router.post('/api/wallet/opennode', auth, async (req, res) => {
    try {
        const { api_key, env } = req.body;
        if (!api_key) return res.status(400).json({ error: 'API key required' });

        const baseUrl = env === 'dev' ? 'https://dev-api.opennode.com' : 'https://api.opennode.com';
        await axios.get(`${baseUrl}/v1/account/payment/summary`, {
            headers: { Authorization: api_key.trim() },
            timeout: 5000
        });

        await db.query(
            'UPDATE resellers SET wallet_type = "opennode", opennode_api_key = ?, opennode_env = ? WHERE id = ?',
            [api_key.trim(), env || 'live', req.reseller.id]
        );

        res.json({ success: true, message: 'OpenNode API connected' });
    } catch (e) {
        res.status(400).json({ error: 'OpenNode API key invalid or unreachable' });
    }
});

// POST /api/wallet/btcpay
router.post('/api/wallet/btcpay', auth, async (req, res) => {
    try {
        const { url, store_id, api_key, webhook_id, webhook_secret } = req.body;
        if (!url || !store_id || !api_key) return res.status(400).json({ error: 'URL, Store ID and API key required' });

        await db.query(
            'UPDATE resellers SET wallet_type = "btcpay", btcpay_url = ?, btcpay_store_id = ?, btcpay_api_key = ?, btcpay_webhook_id = ?, btcpay_webhook_secret = ? WHERE id = ?',
            [url.trim(), store_id.trim(), api_key.trim(), webhook_id || null, webhook_secret || null, req.reseller.id]
        );

        res.json({ success: true, message: 'BTCPay Server saved' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/wallet/telegram - Save Telegram bot token and chat ID
router.post('/api/wallet/telegram', auth, async (req, res) => {
    try {
        const { bot_token, chat_id } = req.body;
        const cleanToken = (bot_token && !bot_token.startsWith('***')) ? bot_token.trim() : null;
        const cleanChatId = (chat_id && !chat_id.startsWith('***')) ? chat_id.trim() : null;

        await db.query(
            `UPDATE resellers SET
                telegram_bot_token = COALESCE(?, telegram_bot_token),
                telegram_chat_id = COALESCE(?, telegram_chat_id)
             WHERE id = ?`,
            [cleanToken, cleanChatId, req.reseller.id]
        );

        res.json({ success: true, message: 'Telegram settings saved successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/wallet/test-telegram - Send test message
router.post('/api/wallet/test-telegram', auth, async (req, res) => {
    try {
        const { bot_token, chat_id } = req.body;
        const [rows] = await db.query('SELECT * FROM resellers WHERE id = ?', [req.reseller.id]);
        const r = rows[0] || req.reseller;

        const token = (bot_token && !bot_token.startsWith('***')) ? bot_token.trim() : r.telegram_bot_token;
        const cid = (chat_id && !chat_id.startsWith('***')) ? chat_id.trim() : r.telegram_chat_id;

        if (!token || !cid) {
            return res.status(400).json({ error: 'Please enter your Telegram Bot Token and Chat ID first.' });
        }

        const msg = 
`⚡ <b>Lightning Pay Connected!</b>

🤖 Your Telegram Bot notifications are working perfectly!
You will receive real-time alerts whenever a customer sends Sats or when an Auto-Sweep to Binance occurs.`;

        await TelegramService.sendMessage({ botToken: token, chatId: cid, message: msg });
        res.json({ success: true, message: 'Test message sent to your Telegram!' });
    } catch (err) {
        res.status(400).json({ error: 'Telegram Error: ' + err.message });
    }
});

module.exports = router;
