const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../database/db');
const auth = require('../middleware/auth');
const { requireRole } = auth;

// All owner routes require authenticated owner role
router.use('/api/owner', auth, requireRole('owner'));

// GET /api/owner/stats — Global System Overview
router.get('/api/owner/stats', async (req, res) => {
    try {
        const [[resellerCount]] = await db.query(
            "SELECT COUNT(*) as count FROM resellers WHERE role = 'reseller'"
        );

        const [[subUserCount]] = await db.query(
            "SELECT COUNT(*) as count FROM sub_users"
        );

        const [[paymentStats]] = await db.query(
            `SELECT 
                COUNT(*) as total_payments,
                SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END) as paid_count,
                COALESCE(SUM(CASE WHEN status = 'paid' THEN total_usd ELSE 0 END), 0) as total_volume_usd,
                COALESCE(SUM(CASE WHEN status = 'paid' THEN btc_amount ELSE 0 END), 0) as total_btc
             FROM payments`
        );

        const [[linkStats]] = await db.query(
            "SELECT COUNT(*) as total_links FROM payment_links WHERE status = 'active'"
        );

        res.json({
            resellers: resellerCount?.count || 0,
            sub_users: subUserCount?.count || 0,
            total_links: linkStats?.total_links || 0,
            total_payments: paymentStats?.total_payments || 0,
            paid_count: paymentStats?.paid_count || 0,
            total_volume_usd: Number(paymentStats?.total_volume_usd || 0).toFixed(2),
            total_volume_sats: Math.round(Number(paymentStats?.total_btc || 0) * 100_000_000)
        });
    } catch (err) {
        console.error('[owner] Stats error:', err);
        res.status(500).json({ error: 'Failed to fetch owner platform stats' });
    }
});

// GET /api/owner/resellers — List All Reseller Panels (with plain_password)
router.get('/api/owner/resellers', async (req, res) => {
    try {
        const [resellers] = await db.query(
            `SELECT 
                r.id, r.username, r.email, r.role, r.status, r.wallet_type, r.plain_password, r.created_at,
                (SELECT COUNT(*) FROM sub_users su WHERE su.reseller_id = r.id) as sub_user_count,
                (SELECT COUNT(*) FROM payment_links pl WHERE pl.reseller_id = r.id) as link_count,
                COALESCE((SELECT SUM(total_usd) FROM payments p WHERE p.reseller_id = r.id AND p.status = 'paid'), 0) as paid_volume_usd
             FROM resellers r
             WHERE r.role = 'reseller'
             ORDER BY r.created_at DESC`
        );

        res.json(resellers.map(r => ({
            ...r,
            paid_volume_usd: Number(r.paid_volume_usd).toFixed(2)
        })));
    } catch (err) {
        console.error('[owner] List resellers error:', err);
        res.status(500).json({ error: 'Failed to fetch resellers list' });
    }
});

// GET /api/owner/resellers/:id — Fetch Single Reseller Complete Config
router.get('/api/owner/resellers/:id', async (req, res) => {
    try {
        const resellerId = parseInt(req.params.id, 10);
        const [rows] = await db.query('SELECT * FROM resellers WHERE id = ?', [resellerId]);
        if (!rows.length) return res.status(404).json({ error: 'Reseller not found' });
        
        const r = rows[0];
        delete r.password; // Do not return bcrypt hash
        res.json(r);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch reseller configuration' });
    }
});

// POST /api/owner/resellers — Generate & Sell New Reseller Panel
router.post('/api/owner/resellers', async (req, res) => {
    try {
        const { username, email, password } = req.body;

        if (!username || !email || !password) {
            return res.status(400).json({ error: 'Username, email, and password are required' });
        }

        if (password.length < 8) {
            return res.status(400).json({ error: 'Password must be at least 8 characters' });
        }

        if (!/^[a-zA-Z0-9_]{3,30}$/.test(username)) {
            return res.status(400).json({ error: 'Username must be 3–30 characters (letters, numbers, underscore)' });
        }

        const [existing] = await db.query(
            'SELECT id FROM resellers WHERE username = ? OR email = ?',
            [username, email]
        );
        if (existing.length) {
            return res.status(400).json({ error: 'Username or email already taken' });
        }

        const hash = await bcrypt.hash(password, 12);
        const [result] = await db.query(
            "INSERT INTO resellers (username, email, password, plain_password, role, status) VALUES (?, ?, ?, ?, 'reseller', 'active')",
            [username, email, hash, password]
        );

        await db.query(
            'INSERT INTO activities (reseller_id, actor, event, description, ip) VALUES (?, ?, ?, ?, ?)',
            [req.reseller.id, req.reseller.username, 'create_reseller_panel', `Generated panel for ${username}`, req.clientIp]
        );

        res.json({
            success: true,
            message: `Reseller panel for ${username} created successfully`,
            reseller: {
                id: result.insertId,
                username,
                email,
                plain_password: password,
                role: 'reseller',
                status: 'active'
            }
        });
    } catch (err) {
        console.error('[owner] Create reseller error:', err);
        res.status(500).json({ error: 'Failed to generate reseller panel' });
    }
});

// PUT /api/owner/resellers/:id/config — Master Owner Full Config Update
router.put('/api/owner/resellers/:id/config', async (req, res) => {
    try {
        const resellerId = parseInt(req.params.id, 10);
        const [rows] = await db.query('SELECT id FROM resellers WHERE id = ?', [resellerId]);
        if (!rows.length) return res.status(404).json({ error: 'Reseller not found' });

        const {
            username, email, password, status,
            wallet_type, wallet_email,
            blink_api_key, blink_api_keys, blink_wallet_id,
            lnbits_url, lnbits_invoice_key, lnbits_admin_key,
            opennode_api_key, opennode_env,
            alby_access_token, alby_nwc_string,
            binance_api_key, binance_api_secret,
            binance_auto_sweep_enabled, binance_sweep_threshold_usd,
            binance_sweep_type, binance_sweep_wallet_balance_enabled,
            auto_payout_enabled, auto_payout_address, auto_payout_percent,
            telegram_bot_token, telegram_chat_id,
            charge_mode, charge_value
        } = req.body;

        const updates = [];
        const params = [];

        const addField = (col, val) => {
            if (val !== undefined) {
                updates.push(`${col} = ?`);
                params.push(val);
            }
        };

        if (username) addField('username', username.trim());
        if (email) addField('email', email.trim());
        if (password && password.length >= 8) {
            const hash = await bcrypt.hash(password, 12);
            addField('password', hash);
            addField('plain_password', password);
        }

        addField('status', status);
        addField('wallet_type', wallet_type);
        addField('wallet_email', wallet_email);
        addField('blink_api_key', blink_api_key);
        addField('blink_api_keys', blink_api_keys);
        addField('blink_wallet_id', blink_wallet_id);
        addField('lnbits_url', lnbits_url);
        addField('lnbits_invoice_key', lnbits_invoice_key);
        addField('lnbits_admin_key', lnbits_admin_key);
        addField('opennode_api_key', opennode_api_key);
        addField('opennode_env', opennode_env);
        addField('alby_access_token', alby_access_token);
        addField('alby_nwc_string', alby_nwc_string);
        addField('binance_api_key', binance_api_key);
        addField('binance_api_secret', binance_api_secret);
        addField('binance_auto_sweep_enabled', binance_auto_sweep_enabled ? 1 : 0);
        addField('binance_sweep_threshold_usd', binance_sweep_threshold_usd);
        addField('binance_sweep_type', binance_sweep_type);
        addField('binance_sweep_wallet_balance_enabled', binance_sweep_wallet_balance_enabled ? 1 : 0);
        addField('auto_payout_enabled', auto_payout_enabled ? 1 : 0);
        addField('auto_payout_address', auto_payout_address);
        addField('auto_payout_percent', auto_payout_percent);
        addField('telegram_bot_token', telegram_bot_token);
        addField('telegram_chat_id', telegram_chat_id);
        addField('charge_mode', charge_mode);
        addField('charge_value', charge_value);

        if (!updates.length) {
            return res.status(400).json({ error: 'No configuration fields provided for update' });
        }

        params.push(resellerId);
        await db.query(`UPDATE resellers SET ${updates.join(', ')} WHERE id = ?`, params);

        await db.query(
            'INSERT INTO activities (reseller_id, actor, event, description, ip) VALUES (?, ?, ?, ?, ?)',
            [req.reseller.id, req.reseller.username, 'master_config_update', `Full configuration updated for reseller #${resellerId}`, req.clientIp]
        );

        res.json({ success: true, message: `Configuration updated for reseller #${resellerId}` });
    } catch (err) {
        console.error('[owner] Config update error:', err);
        res.status(500).json({ error: 'Failed to update reseller configuration' });
    }
});

// PUT /api/owner/resellers/:id/status — Toggle Suspend / Activate
router.put('/api/owner/resellers/:id/status', async (req, res) => {
    try {
        const { status } = req.body;
        if (!['active', 'suspended'].includes(status)) {
            return res.status(400).json({ error: "Status must be 'active' or 'suspended'" });
        }

        const resellerId = parseInt(req.params.id, 10);
        if (resellerId === req.reseller.id) {
            return res.status(400).json({ error: 'Owner cannot suspend their own account' });
        }

        await db.query('UPDATE resellers SET status = ? WHERE id = ?', [status, resellerId]);

        await db.query(
            'INSERT INTO activities (reseller_id, actor, event, description, ip) VALUES (?, ?, ?, ?, ?)',
            [req.reseller.id, req.reseller.username, 'update_reseller_status', `Updated reseller ${resellerId} status to ${status}`, req.clientIp]
        );

        res.json({ success: true, message: `Reseller status set to ${status}` });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update reseller status' });
    }
});

// POST /api/owner/resellers/:id/reset-password — Reset Reseller Password
router.post('/api/owner/resellers/:id/reset-password', async (req, res) => {
    try {
        const { new_password } = req.body;
        if (!new_password || new_password.length < 8) {
            return res.status(400).json({ error: 'New password must be at least 8 characters' });
        }

        const resellerId = parseInt(req.params.id, 10);
        const hash = await bcrypt.hash(new_password, 12);

        await db.query('UPDATE resellers SET password = ?, plain_password = ? WHERE id = ?', [hash, new_password, resellerId]);

        res.json({ success: true, message: 'Reseller password updated successfully' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to reset reseller password' });
    }
});

// GET /api/owner/sub-users — List All Merchant Sub-Users Across Platform
router.get('/api/owner/sub-users', async (req, res) => {
    try {
        const [subUsers] = await db.query(
            `SELECT 
                su.id, su.name, su.email, su.rate_per_dollar, su.plain_password, su.created_at,
                r.username as reseller_username, r.email as reseller_email
             FROM sub_users su
             JOIN resellers r ON su.reseller_id = r.id
             ORDER BY su.created_at DESC`
        );

        res.json(subUsers);
    } catch (err) {
        console.error('[owner] List sub-users error:', err);
        res.status(500).json({ error: 'Failed to fetch sub-users list' });
    }
});

// POST /api/owner/sub-users/:id/reset-password — Reset Merchant Sub-User Password
router.post('/api/owner/sub-users/:id/reset-password', async (req, res) => {
    try {
        const { new_password } = req.body;
        if (!new_password || new_password.length < 8) {
            return res.status(400).json({ error: 'New password must be at least 8 characters' });
        }

        const subUserId = parseInt(req.params.id, 10);
        const hash = await bcrypt.hash(new_password, 12);

        await db.query('UPDATE sub_users SET password = ?, plain_password = ? WHERE id = ?', [hash, new_password, subUserId]);

        res.json({ success: true, message: 'Merchant sub-user password updated successfully' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to reset sub-user password' });
    }
});

module.exports = router;