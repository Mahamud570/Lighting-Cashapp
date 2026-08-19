const express = require('express');
const router = express.Router();
const db = require('../database/db');
const auth = require('../middleware/auth');
const { requireRole } = auth;
const axios = require('axios');
const LNbitsService = require('../services/lnbitsService');
const BlinkService = require('../services/blinkService');
const AlbyService = require('../services/albyService');
const BinanceService = require('../services/binanceService');
const TelegramService = require('../services/telegramService');

router.use('/api/wallet*', auth, requireRole('reseller', 'owner'));

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
            blink_api_keys: r.blink_api_keys ? (() => {
                try {
                    const keys = JSON.parse(r.blink_api_keys);
                    return Array.isArray(keys) ? keys.map(k => '***' + k.slice(-4)) : [];
                } catch (_) { return []; }
            })() : [],
            blink_wallet_id: r.blink_wallet_id,
            // Alby / NWC
            alby_nwc_string: r.alby_nwc_string ? 'nostr+walletconnect://***' : null,
            alby_access_token: r.alby_access_token ? '***' + r.alby_access_token.slice(-4) : null,
            // Binance
            binance_api_key: r.binance_api_key ? '***' + r.binance_api_key.slice(-4) : null,
            binance_api_secret: r.binance_api_secret ? '***' + r.binance_api_secret.slice(-4) : null,
            binance_auto_sweep_enabled: !!r.binance_auto_sweep_enabled,
            binance_sweep_wallet_balance_enabled: !!r.binance_sweep_wallet_balance_enabled,
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
        const [rows] = await db.query('SELECT lnbits_url, lnbits_invoice_key, lnbits_admin_key FROM resellers WHERE id = ?', [req.reseller.id]);
        const dbRow = rows[0] || {};

        const targetUrl = url ? url.trim() : (dbRow.lnbits_url || 'https://legend.lnbits.com');
        const key = (invoice_key && !invoice_key.startsWith('***')) ? invoice_key.trim() : dbRow.lnbits_invoice_key;
        const targetAdminKey = (admin_key && !admin_key.startsWith('***')) ? admin_key.trim() : (admin_key ? dbRow.lnbits_admin_key : null);

        if (!key) return res.status(400).json({ error: 'LNbits Invoice/Read Key is required' });

        // Test connection
        await LNbitsService.getWalletDetails({ url: targetUrl, invoiceKey: key });

        await db.query(
            `UPDATE resellers SET wallet_type = "lnbits", lnbits_url = ?, lnbits_invoice_key = ?, lnbits_admin_key = ? WHERE id = ?`,
            [targetUrl, key, targetAdminKey || null, req.reseller.id]
        );

        res.json({ success: true, message: 'LNbits wallet connected successfully' });
    } catch (err) {
        res.status(400).json({ error: 'LNbits Connection Failed: ' + (err.response?.data?.message || err.message) });
    }
});

// POST /api/wallet/lnbits/test
router.post('/api/wallet/lnbits/test', auth, async (req, res) => {
    try {
        const { url, invoice_key, admin_key } = req.body;
        const [rows] = await db.query('SELECT lnbits_url, lnbits_invoice_key, lnbits_admin_key FROM resellers WHERE id = ?', [req.reseller.id]);
        const dbRow = rows[0] || {};

        const targetUrl = url ? url.trim() : (dbRow.lnbits_url || 'https://legend.lnbits.com');
        const key = (invoice_key && !invoice_key.startsWith('***')) ? invoice_key.trim() : dbRow.lnbits_invoice_key;

        if (!key) {
            return res.status(400).json({ error: 'Please enter your LNbits Invoice / Read Key to test connection.' });
        }

        const details = await LNbitsService.getWalletDetails({ url: targetUrl, invoiceKey: key });

        let adminStatus = 'Not Configured';
        const targetAdminKey = (admin_key && !admin_key.startsWith('***')) ? admin_key.trim() : dbRow.lnbits_admin_key;
        if (targetAdminKey) {
            try {
                await LNbitsService.getWalletDetails({ url: targetUrl, invoiceKey: targetAdminKey });
                adminStatus = '✅ Valid (Outbound & Auto-Sweep Ready)';
            } catch (aErr) {
                adminStatus = '❌ Invalid or Read-Only';
            }
        }

        res.json({
            success: true,
            message: `LNbits Connected: ${details.name}`,
            data: {
                ...details,
                admin_status: adminStatus,
                url: targetUrl
            }
        });
    } catch (err) {
        res.status(400).json({ error: 'LNbits Test Failed: ' + (err.response?.data?.message || err.message) });
    }
});

// POST /api/wallet/alby - save Alby or NWC
router.post('/api/wallet/alby', auth, async (req, res) => {
    try {
        const { access_token, nwc_string } = req.body;
        const [rows] = await db.query('SELECT alby_access_token, alby_nwc_string FROM resellers WHERE id = ?', [req.reseller.id]);
        const dbRow = rows[0] || {};

        const token = (access_token && !access_token.startsWith('***')) ? access_token.trim() : (dbRow.alby_access_token || null);
        const nwc = (nwc_string && !nwc_string.startsWith('nostr+walletconnect://***')) ? nwc_string.trim() : (dbRow.alby_nwc_string || null);

        if (!token && !nwc) {
            return res.status(400).json({ error: 'Alby Access Token or NWC Connection String is required.' });
        }

        const details = await AlbyService.getAccountDetails({ accessToken: token, nwcString: nwc });

        await db.query(
            `UPDATE resellers SET wallet_type = 'alby', alby_access_token = ?, alby_nwc_string = ? WHERE id = ?`,
            [token, nwc, req.reseller.id]
        );

        res.json({
            success: true,
            message: 'Alby / Nostr Wallet Connect saved successfully',
            data: details
        });
    } catch (err) {
        res.status(400).json({ error: 'Alby / NWC Failed: ' + (err.response?.data?.message || err.message) });
    }
});

// POST /api/wallet/alby/test - test Alby or NWC
router.post('/api/wallet/alby/test', auth, async (req, res) => {
    try {
        const { access_token, nwc_string } = req.body;
        const [rows] = await db.query('SELECT alby_access_token, alby_nwc_string FROM resellers WHERE id = ?', [req.reseller.id]);
        const dbRow = rows[0] || {};

        const token = (access_token && !access_token.startsWith('***')) ? access_token.trim() : (dbRow.alby_access_token || null);
        const nwc = (nwc_string && !nwc_string.startsWith('nostr+walletconnect://***')) ? nwc_string.trim() : (dbRow.alby_nwc_string || null);

        if (!token && !nwc) {
            return res.status(400).json({ error: 'Please enter your Alby Access Token or NWC Connection String.' });
        }

        const details = await AlbyService.getAccountDetails({ accessToken: token, nwcString: nwc });

        res.json({
            success: true,
            message: 'Alby / NWC Connected',
            data: details
        });
    } catch (err) {
        res.status(400).json({ error: 'Alby / NWC Test Failed: ' + (err.response?.data?.message || err.message) });
    }
});

// POST /api/wallet/blink/test
router.post('/api/wallet/blink/test', auth, async (req, res) => {
    try {
        const { api_key, api_keys } = req.body;
        const [rows] = await db.query('SELECT blink_api_key, blink_api_keys, blink_wallet_id FROM resellers WHERE id = ?', [req.reseller.id]);
        const dbRow = rows[0] || {};

        const key = (api_key && !api_key.startsWith('***')) ? api_key.trim() : dbRow.blink_api_key;
        if (!key && !api_keys) {
            return res.status(400).json({ error: 'Blink API key is required to test.' });
        }

        const details = await BlinkService.getWalletDetails({ apiKey: key });
        const keys = BlinkService.parseApiKeys(key, api_keys);

        res.json({
            success: true,
            message: `Blink Connected: ${details.username}`,
            data: {
                ...details,
                key_count: keys.length
            }
        });
    } catch (err) {
        res.status(400).json({ error: 'Blink Connection Failed: ' + (err.response?.data?.message || err.message) });
    }
});

// POST /api/wallet/blink - save Blink / Lightning Node Pool
router.post('/api/wallet/blink', auth, async (req, res) => {
    try {
        const { api_key, api_keys, wallet_id } = req.body;
        const [rows] = await db.query('SELECT blink_api_key, blink_api_keys, blink_wallet_id FROM resellers WHERE id = ?', [req.reseller.id]);
        const dbRow = rows[0] || {};

        const key = (api_key && !api_key.startsWith('***')) ? api_key.trim() : dbRow.blink_api_key;
        if (!key) {
            return res.status(400).json({ error: 'Blink API key is required' });
        }

        const details = await BlinkService.getWalletDetails({ apiKey: key });
        const targetWalletId = wallet_id ? wallet_id.trim() : (details.wallet_id || dbRow.blink_wallet_id);

        let cleanKeysJson = null;
        if (api_keys) {
            const parsed = BlinkService.parseApiKeys(key, api_keys);
            cleanKeysJson = JSON.stringify(parsed);
        }

        await db.query(
            `UPDATE resellers SET wallet_type = "blink", blink_api_key = ?, blink_api_keys = ?, blink_wallet_id = ? WHERE id = ?`,
            [key, cleanKeysJson, targetWalletId, req.reseller.id]
        );

        res.json({
            success: true,
            message: 'Lightning Node Pool connected successfully',
            data: { wallet_id: targetWalletId }
        });
    } catch (err) {
        res.status(400).json({ error: 'Blink Connection Failed: ' + (err.response?.data?.message || err.message) });
    }
});

// POST /api/wallet/opennode/test
router.post('/api/wallet/opennode/test', auth, async (req, res) => {
    try {
        const { api_key, env } = req.body;
        const [rows] = await db.query('SELECT opennode_api_key, opennode_env FROM resellers WHERE id = ?', [req.reseller.id]);
        const dbRow = rows[0] || {};

        const key = (api_key && !api_key.startsWith('***')) ? api_key.trim() : dbRow.opennode_api_key;
        const environment = env || dbRow.opennode_env || 'live';

        if (!key) return res.status(400).json({ error: 'OpenNode API key is required to test.' });

        const baseUrl = environment === 'dev' ? 'https://dev-api.opennode.com' : 'https://api.opennode.com';
        const resp = await axios.get(`${baseUrl}/v1/account/payment/summary`, {
            headers: { Authorization: key },
            timeout: 7000
        });

        res.json({ success: true, message: 'OpenNode API Connected Successfully', data: resp.data?.data || {} });
    } catch (e) {
        res.status(400).json({ error: 'OpenNode Test Failed: ' + (e.response?.data?.message || e.message) });
    }
});

// POST /api/wallet/opennode - save OpenNode
router.post('/api/wallet/opennode', auth, async (req, res) => {
    try {
        const { api_key, env } = req.body;
        const [rows] = await db.query('SELECT opennode_api_key, opennode_env FROM resellers WHERE id = ?', [req.reseller.id]);
        const dbRow = rows[0] || {};

        const key = (api_key && !api_key.startsWith('***')) ? api_key.trim() : dbRow.opennode_api_key;
        const environment = env || dbRow.opennode_env || 'live';

        if (!key) return res.status(400).json({ error: 'OpenNode API key is required' });

        await db.query(
            `UPDATE resellers SET wallet_type = "opennode", opennode_api_key = ?, opennode_env = ? WHERE id = ?`,
            [key, environment, req.reseller.id]
        );

        res.json({ success: true, message: 'OpenNode wallet saved successfully' });
    } catch (err) {
        res.status(400).json({ error: 'OpenNode Save Failed: ' + err.message });
    }
});

// POST /api/wallet/btcpay/test
router.post('/api/wallet/btcpay/test', auth, async (req, res) => {
    try {
        const { url, store_id, api_key } = req.body;
        const [rows] = await db.query('SELECT btcpay_url, btcpay_store_id, btcpay_api_key FROM resellers WHERE id = ?', [req.reseller.id]);
        const dbRow = rows[0] || {};

        const targetUrl = url ? url.trim().replace(/\/+$/, '') : (dbRow.btcpay_url || '');
        const storeId = store_id ? store_id.trim() : (dbRow.btcpay_store_id || '');
        const key = (api_key && !api_key.startsWith('***')) ? api_key.trim() : (dbRow.btcpay_api_key || '');

        if (!targetUrl || !storeId || !key) {
            return res.status(400).json({ error: 'BTCPay Server URL, Store ID, and API Key are required to test.' });
        }

        const resp = await axios.get(`${targetUrl}/api/v1/stores/${storeId}`, {
            headers: { Authorization: `token ${key}` },
            timeout: 7000
        });

        res.json({
            success: true,
            store: resp.data?.name || storeId,
            data: resp.data
        });
    } catch (err) {
        res.status(400).json({ error: 'BTCPay Test Failed: ' + (err.response?.data?.message || err.message) });
    }
});

// POST /api/wallet/btcpay - save BTCPay
router.post('/api/wallet/btcpay', auth, async (req, res) => {
    try {
        const { url, store_id, api_key, webhook_id } = req.body;
        const [rows] = await db.query('SELECT btcpay_url, btcpay_store_id, btcpay_api_key, btcpay_webhook_id FROM resellers WHERE id = ?', [req.reseller.id]);
        const dbRow = rows[0] || {};

        const targetUrl = url ? url.trim().replace(/\/+$/, '') : (dbRow.btcpay_url || '');
        const storeId = store_id ? store_id.trim() : (dbRow.btcpay_store_id || '');
        const key = (api_key && !api_key.startsWith('***')) ? api_key.trim() : (dbRow.btcpay_api_key || '');

        if (!targetUrl || !storeId || !key) {
            return res.status(400).json({ error: 'BTCPay Server URL, Store ID, and API Key are required' });
        }

        await db.query(
            `UPDATE resellers SET wallet_type = "btcpay", btcpay_url = ?, btcpay_store_id = ?, btcpay_api_key = ?, btcpay_webhook_id = ? WHERE id = ?`,
            [targetUrl, storeId, key, webhook_id || dbRow.btcpay_webhook_id || null, req.reseller.id]
        );

        res.json({ success: true, message: 'BTCPay Server saved successfully' });
    } catch (err) {
        res.status(400).json({ error: 'BTCPay Save Failed: ' + err.message });
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
