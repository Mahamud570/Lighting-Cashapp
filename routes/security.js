const express = require('express');
const router = express.Router();
const db = require('../database/db');
const auth = require('../middleware/auth');
const { requireRole } = auth;
const bcrypt = require('bcryptjs');
const speakeasy = require('speakeasy');
const qrcode = require('qrcode');
const crypto = require('crypto');

// GET /api/security/status
router.get('/api/security/status', auth, requireRole('reseller', 'owner'), async (req, res) => {
    // FIX: Wrapped in try/catch — missing handler caused unhandled promise rejection
    try {
        const r = req.reseller;

        // Get active (non-expired) trusted devices
        const [devices] = await db.query(
            "SELECT id, ip, device_type, user_agent, last_active, expires_at FROM sessions WHERE reseller_id = ? AND expires_at > datetime('now') ORDER BY last_active DESC",
            [r.id]
        );

        // Get activity log
        const [activity] = await db.query(
            'SELECT event, actor, ip, device, created_at FROM activities WHERE reseller_id = ? ORDER BY created_at DESC LIMIT 20',
            [r.id]
        );

        res.json({
            totp_enabled: !!r.totp_enabled,
            devices,
            activity
        });
    } catch (err) {
        console.error('Security status error:', err);
        res.status(500).json({ error: 'Failed to load security status' });
    }
});

// POST /api/security/totp/setup - generate TOTP secret & QR
// The secret is stored immediately in `totp_secret` but `totp_enabled` stays 0
// until the user verifies via /totp/enable. This is an acceptable two-phase pattern
// because possession of a TOTP secret without totp_enabled=1 has no security impact.
router.post('/api/security/totp/setup', auth, requireRole('reseller', 'owner'), async (req, res) => {
    try {
        const secret = speakeasy.generateSecret({
            name:   `LightningPay (${req.reseller.username})`,
            length: 20
        });

        // Stage the secret — it becomes active only after /totp/enable confirms it
        await db.query(
            'UPDATE resellers SET totp_secret = ?, totp_enabled = 0 WHERE id = ?',
            [secret.base32, req.reseller.id]
        );

        const qrUrl = await qrcode.toDataURL(secret.otpauth_url);
        res.json({ secret: secret.base32, qr: qrUrl });
    } catch (err) {
        res.status(500).json({ error: 'Failed to generate 2FA secret' });
    }
});

// POST /api/security/totp/enable
router.post('/api/security/totp/enable', auth, requireRole('reseller', 'owner'), async (req, res) => {
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
// S-004 FIX: Require current password in addition to TOTP code before disabling 2FA.
// Without this, a captured 30-second TOTP code (e.g. via shoulder surfing) could
// permanently disable 2FA with no password barrier.
router.post('/api/security/totp/disable', auth, requireRole('reseller', 'owner'), async (req, res) => {
    try {
        const { code, current_password } = req.body;
        const r = req.reseller;

        // Require current password as a second factor before disabling 2FA
        if (!current_password) {
            return res.status(400).json({ error: 'Current password is required to disable 2FA' });
        }

        // Fetch full reseller record to get hashed password
        const [rows] = await db.query('SELECT password FROM resellers WHERE id = ?', [r.id]);
        if (!rows.length) return res.status(404).json({ error: 'Account not found' });

        const passwordValid = await bcrypt.compare(current_password, rows[0].password);
        if (!passwordValid) {
            return res.status(403).json({ error: 'Incorrect current password' });
        }

        if (!r.totp_secret) {
            return res.status(400).json({ error: '2FA is not configured' });
        }

        const valid = speakeasy.totp.verify({
            secret:   r.totp_secret,
            encoding: 'base32',
            token:    code,
            window:   2
        });

        if (!valid) return res.status(400).json({ error: 'Invalid 2FA code' });

        await db.query('UPDATE resellers SET totp_enabled = 0, totp_secret = NULL WHERE id = ?', [r.id]);

        // Log this security event
        await db.query(
            'INSERT INTO activities (reseller_id, actor, event, ip, device) VALUES (?,?,?,?,?)',
            [r.id, r.username, '2fa_disabled', req.clientIp || req.ip, req.headers['user-agent']]
        );

        res.json({ success: true, message: '2FA disabled' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to disable 2FA' });
    }
});

// POST /api/security/password
// S-008 FIX: Require current password verification before changing password.
// Previously, any authenticated session could change the password with no additional
// proof of identity — a stolen session cookie would be enough for a full account takeover.
router.post('/api/security/password', auth, async (req, res) => {
    try {
        const { current_password, new_password, confirm_password } = req.body || {};

        if (!current_password) {
            return res.status(400).json({ error: 'Current password is required' });
        }
        if (!new_password || new_password.length < 8) {
            return res.status(400).json({ error: 'New password must be at least 8 characters' });
        }
        if (new_password !== confirm_password) {
            return res.status(400).json({ error: 'Passwords do not match' });
        }
        if (new_password === current_password) {
            return res.status(400).json({ error: 'New password must differ from current password' });
        }

        const isSubUser = !!req.sub_user;
        const targetTable = isSubUser ? 'sub_users' : 'resellers';
        const targetId = isSubUser ? req.sub_user.id : req.reseller.id;

        // Fetch hashed password to verify current password
        const [rows] = await db.query(`SELECT password FROM ${targetTable} WHERE id = ?`, [targetId]);
        if (!rows.length) return res.status(404).json({ error: 'Account not found' });

        const currentValid = await bcrypt.compare(current_password, rows[0].password);
        if (!currentValid) {
            return res.status(403).json({ error: 'Incorrect current password' });
        }

        const hash = await bcrypt.hash(new_password, 12);
        await db.query(`UPDATE ${targetTable} SET password = ?, must_change_password = 0 WHERE id = ?`, [hash, targetId]);

        // Revoke all other active sessions for this account across devices
        if (req.tokenHash) {
            await db.query('DELETE FROM sessions WHERE reseller_id = ? AND token_hash != ?', [req.reseller.id, req.tokenHash]).catch(() => {});
        }

        if (isSubUser) {
            await db.query(
                'INSERT INTO activities (reseller_id, sub_user_id, actor, event, ip, device) VALUES (?,?,?,?,?,?)',
                [req.reseller.id, req.sub_user.id, req.sub_user.name, 'password_changed', req.clientIp || req.ip, req.headers['user-agent']]
            );
        } else {
            await db.query(
                'INSERT INTO activities (reseller_id, actor, event, ip, device) VALUES (?,?,?,?,?)',
                [req.reseller.id, req.reseller.username, 'password_changed', req.clientIp || req.ip, req.headers['user-agent']]
            );
        }

        res.json({ success: true, message: 'Password updated successfully' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update password' });
    }
});

// DELETE /api/security/devices/:tokenHash - remove device
router.delete('/api/security/devices/:tokenHash', auth, requireRole('reseller', 'owner'), async (req, res) => {
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
router.delete('/api/security/devices', auth, requireRole('reseller', 'owner'), async (req, res) => {
    try {
        await db.query('DELETE FROM sessions WHERE reseller_id = ? AND token_hash != ?', [req.reseller.id, req.tokenHash]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/security/devices
router.get('/api/security/devices', auth, requireRole('reseller', 'owner'), async (req, res) => {
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
