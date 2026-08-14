const express = require('express');
const router = express.Router();
const db = require('../database/db');
const auth = require('../middleware/auth');
const bcrypt = require('bcryptjs');
const speakeasy = require('speakeasy');
const qrcode = require('qrcode');
const crypto = require('crypto');

// GET /api/security/status
router.get('/api/security/status', auth, async (req, res) => {
    const r = req.reseller;

    // Get trusted devices
    const [devices] = await db.query(
        "SELECT * FROM sessions WHERE reseller_id = ? AND expires_at > datetime('now') ORDER BY last_active DESC",
        [r.id]
    );

    // Get activity log
    const [activity] = await db.query(
        'SELECT * FROM activities WHERE reseller_id = ? ORDER BY created_at DESC LIMIT 20',
        [r.id]
    );

    res.json({
        totp_enabled: r.totp_enabled,
        devices,
        activity
    });
});

// POST /api/security/totp/setup - generate TOTP secret & QR
router.post('/api/security/totp/setup', auth, async (req, res) => {
    try {
        const secret = speakeasy.generateSecret({ name: `LightningPay (${req.reseller.username})`, length: 20 });
        // Temporarily store in session; user must confirm with code
        req.session = req.session || {};

        // Store in DB temporarily
        await db.query('UPDATE resellers SET totp_secret = ? WHERE id = ?', [secret.base32, req.reseller.id]);

        const qrUrl = await qrcode.toDataURL(secret.otpauth_url);
        res.json({ secret: secret.base32, qr: qrUrl });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/security/totp/enable
router.post('/api/security/totp/enable', auth, async (req, res) => {
    try {
        const { code } = req.body;
        const r = req.reseller;

        if (!r.totp_secret) return res.status(400).json({ error: 'Setup TOTP first' });

        const valid = speakeasy.totp.verify({
            secret: r.totp_secret,
            encoding: 'base32',
            token: code,
            window: 2
        });

        if (!valid) return res.status(400).json({ error: 'Invalid code' });

        await db.query('UPDATE resellers SET totp_enabled = 1 WHERE id = ?', [r.id]);
        res.json({ success: true, message: '2FA enabled successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/security/totp/disable
router.post('/api/security/totp/disable', auth, async (req, res) => {
    try {
        const { code } = req.body;
        const r = req.reseller;

        const valid = speakeasy.totp.verify({
            secret: r.totp_secret,
            encoding: 'base32',
            token: code,
            window: 2
        });

        if (!valid) return res.status(400).json({ error: 'Invalid code' });

        await db.query('UPDATE resellers SET totp_enabled = 0, totp_secret = NULL WHERE id = ?', [r.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/security/password
router.post('/api/security/password', auth, async (req, res) => {
    try {
        const { new_password, confirm_password } = req.body;
        if (!new_password || new_password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 chars' });
        if (new_password !== confirm_password) return res.status(400).json({ error: 'Passwords do not match' });

        const hash = await bcrypt.hash(new_password, 12);
        await db.query('UPDATE resellers SET password = ? WHERE id = ?', [hash, req.reseller.id]);

        await db.query(
            'INSERT INTO activities (reseller_id, actor, event, ip, device) VALUES (?,?,?,?,?)',
            [req.reseller.id, req.reseller.username, 'password_changed', req.ip, req.headers['user-agent']]
        );

        res.json({ success: true, message: 'Password updated' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/security/devices/:tokenHash - remove device
router.delete('/api/security/devices/:tokenHash', auth, async (req, res) => {
    try {
        if (req.params.tokenHash === req.tokenHash) {
            return res.status(400).json({ error: 'Cannot remove current device' });
        }
        await db.query('DELETE FROM sessions WHERE token_hash = ? AND reseller_id = ?', [req.params.tokenHash, req.reseller.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/security/devices - remove all other devices
router.delete('/api/security/devices', auth, async (req, res) => {
    try {
        await db.query('DELETE FROM sessions WHERE reseller_id = ? AND token_hash != ?', [req.reseller.id, req.tokenHash]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/security/devices
router.get('/api/security/devices', auth, async (req, res) => {
    try {
        const [devices] = await db.query(
            "SELECT *, token_hash as id FROM sessions WHERE reseller_id = ? AND expires_at > datetime('now') ORDER BY last_active DESC",
            [req.reseller.id]
        );
        res.json({ devices, currentToken: req.tokenHash });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
