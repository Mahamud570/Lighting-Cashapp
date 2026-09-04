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
const { resolveStoredSecret, maskSecret } = require('../utils/secrets');

router.use('/api/wallet*', auth, requireRole('reseller', 'owner'));

const isMasked = value => typeof value === 'string' && value.startsWith('***');
const clean = value => typeof value === 'string' ? value.trim() : '';

function parseSubmittedKeys(value) {
    if (Array.isArray(value)) return value.map(clean).filter(Boolean);
    const submitted = clean(value);
    if (!submitted) return [];
    try {
        const parsed = JSON.parse(submitted);
        if (Array.isArray(parsed)) return parsed.map(clean).filter(Boolean);
    } catch (_) {}
    return submitted.split(/[\n,]+/).map(clean).filter(Boolean);
}

function unique(values) {
    return [...new Set(values.filter(Boolean))];
}

// GET /api/wallet - retrieve all connected gateway configs and balances
router.get('/api/wallet', auth, async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM resellers WHERE id = ?', [req.reseller.id]);
        const r = rows[0] || req.reseller;

        res.json({
            wallet_type: r.wallet_type,
            wallet_email: r.wallet_email,
            // OpenNode
            opennode_api_key: maskSecret(r.opennode_api_key),
            opennode_env: r.opennode_env,
            // BTCPay
            btcpay_url: r.btcpay_url,
            btcpay_store_id: r.btcpay_store_id,
            btcpay_api_key: r.btcpay_api_key ? '***' + r.btcpay_api_key.slice(-4) : null,
            btcpay_webhook_id: r.btcpay_webhook_id,
            btcpay_webhook_secret: maskSecret(r.btcpay_webhook_secret),
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
            status: r.wallet_type ? 'active' : 'inactive',
            credentials_required: (() => {
                const missing = [];
                if (r.wallet_type === 'lnbits' && !r.lnbits_invoice_key) missing.push('LNbits Invoice Key');
                if (r.wallet_type === 'blink' && !r.blink_api_key && !r.blink_api_keys) missing.push('Blink API Key');
                if (r.wallet_type === 'opennode' && !r.opennode_api_key) missing.push('OpenNode API Key');
                if (r.wallet_type === 'btcpay' && (!r.btcpay_url || !r.btcpay_store_id || !r.btcpay_api_key)) missing.push('BTCPay credentials');
                if (r.wallet_type === 'alby' && !r.alby_access_token && !r.alby_nwc_string) missing.push('Alby credentials');
                return missing;
            })()
        });
    } catch (err) {
        console.error('[wallet] Load configuration failed:', err && err.message ? err.message : err);
        res.status(500).json({ error: 'Failed to load wallet configuration' });
    }
});

// POST /api/wallet/email - save email / lightning address
router.post('/api/wallet/email', auth, async (req, res) => {
    try {
        const { email } = req.body;
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
            return res.status(400).json({ error: 'A valid Lightning Address is required' });
        }

        await db.query(
            'UPDATE resellers SET wallet_type = "email", wallet_email = ? WHERE id = ?',
            [email.trim(), req.reseller.id]
        );

        res.json({ success: true, message: 'Lightning Address saved' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to save Lightning Address' });
    }
});

// POST /api/wallet/email/test - verify that a Lightning Address exposes a
// usable LNURL-pay endpoint without creating an invoice or moving funds.
router.post('/api/wallet/email/test', auth, async (req, res) => {
    try {
        const address = clean(req.body.email).toLowerCase();
        const match = address.match(/^([^\s@]+)@([^\s@]+\.[^\s@]+)$/);
        if (!match) return res.status(400).json({ error: 'Enter a valid Lightning Address.' });

        const [, username, domain] = match;
        if (domain === 'localhost' || domain.endsWith('.local') || /^\d+(?:\.\d+){3}$/.test(domain)) {
            return res.status(400).json({ error: 'Local or IP-based wallet addresses are not supported.' });
        }

        const endpoint = `https://${domain}/.well-known/lnurlp/${encodeURIComponent(username)}`;
        const response = await axios.get(endpoint, {
            timeout: 7000,
            maxRedirects: 3,
            headers: { Accept: 'application/json' }
        });
        const details = response.data || {};
        if (details.status === 'ERROR') throw new Error(details.reason || 'Wallet provider rejected the address.');
        if (details.tag !== 'payRequest' || !details.callback || !Number.isFinite(Number(details.minSendable)) || !Number.isFinite(Number(details.maxSendable))) {
            throw new Error('Wallet provider returned an invalid LNURL-pay response.');
        }
        const callbackUrl = new URL(details.callback);
        if (callbackUrl.protocol !== 'https:') throw new Error('Wallet callback must use HTTPS.');

        res.json({
            success: true,
            message: 'Address is valid and can receive payments. Automatic confirmation depends on LUD-21 support from the wallet provider.',
            data: {
                address,
                min_sats: Math.ceil(Number(details.minSendable) / 1000),
                max_sats: Math.floor(Number(details.maxSendable) / 1000),
                comment_allowed: Number(details.commentAllowed || 0)
            }
        });
    } catch (err) {
        res.status(400).json({ error: 'LNA test failed. Verify the Lightning Address and try again.' });
    }
});

// POST /api/wallet/blink/test - validate a single key or every key in the pool
router.post('/api/wallet/blink/test', auth, async (req, res) => {
    try {
        const [rows] = await db.query(
            'SELECT blink_api_key, blink_api_keys, blink_wallet_id FROM resellers WHERE id = ?',
            [req.reseller.id]
        );
        const current = rows[0] || {};
        const submittedPrimary = clean(req.body.api_key);
        const submittedPool = parseSubmittedKeys(req.body.api_keys);
        const existingPool = parseSubmittedKeys(current.blink_api_keys);
        const keys = unique([
            submittedPrimary && !isMasked(submittedPrimary) ? submittedPrimary : current.blink_api_key,
            ...submittedPool.filter(key => !isMasked(key)),
            ...(submittedPool.some(isMasked) || !submittedPool.length ? existingPool : [])
        ]);

        if (!keys.length) return res.status(400).json({ error: 'At least one LNP API key is required.' });

        const details = [];
        for (const key of keys) details.push(await BlinkService.getWalletDetails({ apiKey: key }));
        const first = details[0];
        if (!first?.wallet_id) throw new Error('The provider did not return a BTC wallet ID.');

        res.json({
            success: true,
            message: 'LNP connection verified',
            data: {
                wallet_id: first.wallet_id,
                balance_sats: details.reduce((sum, item) => sum + Number(item.balance_sats || 0), 0),
                key_count: keys.length
            }
        });
    } catch (err) {
        res.status(400).json({ error: 'Blink test failed. Verify the API key and wallet ID.' });
    }
});

// POST /api/wallet/blink - validate and persist the LNP key pool
router.post('/api/wallet/blink', auth, async (req, res) => {
    try {
        const [rows] = await db.query(
            'SELECT blink_api_key, blink_api_keys, blink_wallet_id FROM resellers WHERE id = ?',
            [req.reseller.id]
        );
        const current = rows[0] || {};
        const submittedPrimary = clean(req.body.api_key);
        const submittedPool = parseSubmittedKeys(req.body.api_keys);
        const existingPool = parseSubmittedKeys(current.blink_api_keys);
        const keys = unique([
            submittedPrimary && !isMasked(submittedPrimary) ? submittedPrimary : current.blink_api_key,
            ...submittedPool.filter(key => !isMasked(key)),
            ...(submittedPool.some(isMasked) || !submittedPool.length ? existingPool : [])
        ]);

        if (!keys.length) return res.status(400).json({ error: 'At least one LNP API key is required.' });

        const details = await BlinkService.getWalletDetails({ apiKey: keys[0] });
        const walletId = clean(req.body.wallet_id) || details.wallet_id || current.blink_wallet_id;
        if (!walletId) throw new Error('The provider did not return a BTC wallet ID.');

        await db.query(
            `UPDATE resellers
             SET wallet_type = 'blink', blink_api_key = ?, blink_api_keys = ?, blink_wallet_id = ?
             WHERE id = ?`,
            [keys[0], JSON.stringify(keys), walletId, req.reseller.id]
        );

        res.json({ success: true, message: 'LNP connected successfully', data: { wallet_id: walletId, key_count: keys.length } });
    } catch (err) {
        res.status(400).json({ error: 'Blink connection failed. Verify the API key and wallet ID.' });
    }
});

// POST /api/wallet/lnbits - save LNbits
router.post('/api/wallet/lnbits', auth, async (req, res) => {
    try {
        const { url, invoice_key, admin_key } = req.body;
        const [rows] = await db.query('SELECT lnbits_url, lnbits_invoice_key, lnbits_admin_key FROM resellers WHERE id = ?', [req.reseller.id]);
        const dbRow = rows[0] || {};

        const targetUrl = url ? url.trim() : (dbRow.lnbits_url || 'https://legend.lnbits.com');
        const key = resolveStoredSecret(invoice_key, dbRow.lnbits_invoice_key);
        const targetAdminKey = resolveStoredSecret(admin_key, dbRow.lnbits_admin_key);

        if (!key) return res.status(400).json({ error: 'LNbits Invoice/Read Key is required' });

        // Test connection
        await LNbitsService.getWalletDetails({ url: targetUrl, invoiceKey: key });

        await db.query(
            `UPDATE resellers SET wallet_type = "lnbits", lnbits_url = ?, lnbits_invoice_key = ?, lnbits_admin_key = ? WHERE id = ?`,
            [targetUrl, key, targetAdminKey || null, req.reseller.id]
        );

        // Read the row back through the persistence layer. A successful API
        // response must mean the credentials will still exist after restart.
        const [savedRows] = await db.query(
            'SELECT wallet_type, lnbits_url, lnbits_invoice_key, lnbits_admin_key FROM resellers WHERE id = ?',
            [req.reseller.id]
        );
        const saved = savedRows[0];
        if (!saved || saved.wallet_type !== 'lnbits' || saved.lnbits_url !== targetUrl || saved.lnbits_invoice_key !== key || saved.lnbits_admin_key !== (targetAdminKey || null)) {
            throw new Error('LNbits settings could not be verified after saving.');
        }

        res.json({ success: true, message: 'LNbits wallet connected successfully' });
    } catch (err) {
        res.status(400).json({ error: `LNbits connection failed: ${err.response?.data?.message || err.message}` });
    }
});

// POST /api/wallet/lnbits/test
router.post('/api/wallet/lnbits/test', auth, async (req, res) => {
    try {
        const { url, invoice_key, admin_key } = req.body;
        const [rows] = await db.query('SELECT lnbits_url, lnbits_invoice_key, lnbits_admin_key FROM resellers WHERE id = ?', [req.reseller.id]);
        const dbRow = rows[0] || {};

        const targetUrl = url ? url.trim() : (dbRow.lnbits_url || 'https://legend.lnbits.com');
        const key = resolveStoredSecret(invoice_key, dbRow.lnbits_invoice_key);

        if (!key) {
            return res.status(400).json({ error: 'Please enter your LNbits Invoice / Read Key to test connection.' });
        }

        const details = await LNbitsService.getWalletDetails({ url: targetUrl, invoiceKey: key });

        let adminStatus = 'Not Configured';
        const targetAdminKey = resolveStoredSecret(admin_key, dbRow.lnbits_admin_key);
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
        res.status(400).json({ error: 'LNbits test failed. Verify the server URL and key.' });
    }
});

// POST /api/wallet/alby - save Alby or NWC
router.post('/api/wallet/alby', auth, async (req, res) => {
    try {
        const { access_token, nwc_string } = req.body;
        const [rows] = await db.query('SELECT alby_access_token, alby_nwc_string FROM resellers WHERE id = ?', [req.reseller.id]);
        const dbRow = rows[0] || {};

        const token = resolveStoredSecret(access_token, dbRow.alby_access_token);
        const nwc = resolveStoredSecret(nwc_string, dbRow.alby_nwc_string);

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
        res.status(400).json({ error: 'Alby / NWC connection failed. Verify the connection details.' });
    }
});

// POST /api/wallet/alby/test - test Alby or NWC
router.post('/api/wallet/alby/test', auth, async (req, res) => {
    try {
        const { access_token, nwc_string } = req.body;
        const [rows] = await db.query('SELECT alby_access_token, alby_nwc_string FROM resellers WHERE id = ?', [req.reseller.id]);
        const dbRow = rows[0] || {};

        const token = resolveStoredSecret(access_token, dbRow.alby_access_token);
        const nwc = resolveStoredSecret(nwc_string, dbRow.alby_nwc_string);

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
        res.status(400).json({ error: 'Alby / NWC test failed. Verify the connection details.' });
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

// POST /api/wallet/opennode - validate and persist OpenNode settings
router.post('/api/wallet/opennode', auth, async (req, res) => {
    try {
        const [rows] = await db.query('SELECT opennode_api_key, opennode_env FROM resellers WHERE id = ?', [req.reseller.id]);
        const current = rows[0] || {};
        const submitted = clean(req.body.api_key);
        const key = submitted && !isMasked(submitted) ? submitted : current.opennode_api_key;
        const environment = req.body.env === 'dev' ? 'dev' : 'live';
        if (!key) return res.status(400).json({ error: 'OpenNode API key is required.' });

        const baseUrl = environment === 'dev' ? 'https://dev-api.opennode.com' : 'https://api.opennode.com';
        await axios.get(`${baseUrl}/v1/account/payment/summary`, {
            headers: { Authorization: key },
            timeout: 7000
        });
        await db.query(
            "UPDATE resellers SET wallet_type = 'opennode', opennode_api_key = ?, opennode_env = ? WHERE id = ?",
            [key, environment, req.reseller.id]
        );
        res.json({ success: true, message: 'OpenNode connected successfully' });
    } catch (err) {
        res.status(400).json({ error: 'OpenNode connection failed. Verify the environment and API key.' });
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
        res.status(400).json({ error: 'BTCPay test failed. Verify the URL, store ID, and API key.' });
    }
});

// POST /api/wallet/btcpay - validate and persist BTCPay settings
router.post('/api/wallet/btcpay', auth, async (req, res) => {
    try {
        const [rows] = await db.query(
            'SELECT btcpay_url, btcpay_store_id, btcpay_api_key, btcpay_webhook_id, btcpay_webhook_secret FROM resellers WHERE id = ?',
            [req.reseller.id]
        );
        const current = rows[0] || {};
        const targetUrl = (clean(req.body.url) || current.btcpay_url || '').replace(/\/+$/, '');
        const storeId = clean(req.body.store_id) || current.btcpay_store_id;
        const submittedKey = clean(req.body.api_key);
        const key = submittedKey && !isMasked(submittedKey) ? submittedKey : current.btcpay_api_key;
        const submittedWebhookSecret = clean(req.body.webhook_secret);
        const webhookSecret = submittedWebhookSecret && !isMasked(submittedWebhookSecret)
            ? submittedWebhookSecret
            : current.btcpay_webhook_secret;
        const webhookId = clean(req.body.webhook_id) || current.btcpay_webhook_id || null;

        if (!targetUrl || !/^https?:\/\//i.test(targetUrl) || !storeId || !key) {
            return res.status(400).json({ error: 'Valid BTCPay URL, Store ID, and API Key are required.' });
        }

        const response = await axios.get(`${targetUrl}/api/v1/stores/${encodeURIComponent(storeId)}`, {
            headers: { Authorization: `token ${key}` },
            timeout: 7000
        });
        await db.query(
            `UPDATE resellers SET wallet_type = 'btcpay', btcpay_url = ?, btcpay_store_id = ?,
                    btcpay_api_key = ?, btcpay_webhook_id = ?, btcpay_webhook_secret = ?
             WHERE id = ?`,
            [targetUrl, storeId, key, webhookId, webhookSecret || null, req.reseller.id]
        );
        res.json({ success: true, message: 'BTCPay Server connected successfully', store: response.data?.name || storeId });
    } catch (err) {
        res.status(400).json({ error: 'BTCPay connection failed. Verify the URL, store ID, and API key.' });
    }
});

// POST /api/wallet/telegram - Save Telegram bot token and chat ID
router.post('/api/wallet/telegram', auth, async (req, res) => {
    try {
        const { bot_token, chat_id } = req.body;
        const cleanToken = (bot_token && !bot_token.startsWith('***')) ? bot_token.trim() : null;
        const cleanChatId = (chat_id && !chat_id.startsWith('***')) ? chat_id.trim() : null;
        const [currentRows] = await db.query('SELECT telegram_bot_token,telegram_chat_id FROM resellers WHERE id=?', [req.reseller.id]);
        const finalToken = cleanToken || currentRows[0]?.telegram_bot_token;
        const finalChatId = cleanChatId || currentRows[0]?.telegram_chat_id;
        if (!finalToken || !finalChatId) return res.status(400).json({ error: 'Bot Token and Chat ID are required. Send /start to the bot before saving.' });
        const bot = await TelegramService.validateBot(finalToken);
        await TelegramService.validateChat({ botToken: finalToken, chatId: finalChatId });

        await db.query(
            `UPDATE resellers SET
                telegram_bot_token = COALESCE(?, telegram_bot_token),
                telegram_chat_id = COALESCE(?, telegram_chat_id)
             WHERE id = ?`,
            [cleanToken, cleanChatId, req.reseller.id]
        );

        res.json({ success: true, message: `Telegram @${bot.username || 'bot'} connected successfully` });
    } catch (err) {
        res.status(400).json({ error: err.message || 'Failed to validate Telegram settings' });
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
