const express = require('express');
const router = express.Router();
const db = require('../database/db');
const auth = require('../middleware/auth');
const axios = require('axios');

// GET /api/wallet
router.get('/api/wallet', auth, async (req, res) => {
    const r = req.reseller;
    res.json({
        wallet_type: r.wallet_type,
        wallet_email: r.wallet_email,
        opennode_api_key: r.opennode_api_key ? '***' + r.opennode_api_key.slice(-4) : null,
        opennode_env: r.opennode_env,
        btcpay_url: r.btcpay_url,
        btcpay_store_id: r.btcpay_store_id,
        btcpay_api_key: r.btcpay_api_key ? '***' + r.btcpay_api_key.slice(-4) : null,
        btcpay_webhook_id: r.btcpay_webhook_id,
        status: r.wallet_type ? 'active' : 'inactive'
    });
});

// POST /api/wallet/email - save email wallet
router.post('/api/wallet/email', auth, async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) return res.status(400).json({ error: 'Email required' });

        await db.query(
            'UPDATE resellers SET wallet_type = "email", wallet_email = ?, opennode_api_key = NULL, btcpay_store_id = NULL WHERE id = ?',
            [email, req.reseller.id]
        );

        res.json({ success: true, message: 'Lightning wallet email saved' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/wallet/opennode - save OpenNode
router.post('/api/wallet/opennode', auth, async (req, res) => {
    try {
        const { api_key, env } = req.body;
        if (!api_key) return res.status(400).json({ error: 'API key required' });

        // Test OpenNode connection
        try {
            const baseUrl = env === 'dev' ? 'https://dev-api.opennode.com' : 'https://api.opennode.com';
            await axios.get(`${baseUrl}/v1/account/payment/summary`, {
                headers: { Authorization: api_key },
                timeout: 5000
            });
        } catch (e) {
            return res.status(400).json({ error: 'OpenNode API key invalid or unreachable' });
        }

        await db.query(
            'UPDATE resellers SET wallet_type = "opennode", opennode_api_key = ?, opennode_env = ? WHERE id = ?',
            [api_key, env || 'live', req.reseller.id]
        );

        res.json({ success: true, message: 'OpenNode API connected' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/wallet/btcpay - save BTCPay
router.post('/api/wallet/btcpay', auth, async (req, res) => {
    try {
        const { url, store_id, api_key, webhook_id, webhook_secret } = req.body;
        if (!url || !store_id || !api_key) return res.status(400).json({ error: 'URL, Store ID and API key required' });

        await db.query(
            'UPDATE resellers SET wallet_type = "btcpay", btcpay_url = ?, btcpay_store_id = ?, btcpay_api_key = ?, btcpay_webhook_id = ?, btcpay_webhook_secret = ? WHERE id = ?',
            [url, store_id, api_key, webhook_id || null, webhook_secret || null, req.reseller.id]
        );

        res.json({ success: true, message: 'BTCPay Server saved' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/wallet/btcpay/test
router.post('/api/wallet/btcpay/test', auth, async (req, res) => {
    try {
        const { url, store_id, api_key } = req.body;
        const response = await axios.get(`${url}/api/v1/stores/${store_id}`, {
            headers: { Authorization: `token ${api_key}` },
            timeout: 5000
        });
        res.json({ success: true, store: response.data.name });
    } catch (err) {
        res.status(400).json({ error: 'Connection failed: ' + (err.response?.data?.message || err.message) });
    }
});

module.exports = router;
