const express = require('express');
const router = express.Router();
const db = require('../database/db');
const auth = require('../middleware/auth');
const { requireRole } = auth;
const bcrypt = require('bcryptjs');
const speakeasy = require('speakeasy');
const qrcode = require('qrcode');

const TRUST_COOKIE = 'trusted_browser';

function clearTrustCookie(res) {
    res.clearCookie(TRUST_COOKIE, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax'
    });
}

router.get('/api/security/status', auth, requireRole('reseller', 'owner'), async (req, res) => {
    try {
        const r = req.reseller;
        const [devices] = await db.query(
            "SELECT id, ip, device_type, user_agent, last_active, created_at, expires_at FROM sessions WHERE account_type = 'reseller' AND account_id = ? AND expires_at > datetime('now') ORDER BY last_active DESC",
            [r.id]
        );
        const [trusted] = await db.query(
            "SELECT id, label, ip, device_type, user_agent, created_at, last_used, expires_at FROM trusted_devices WHERE reseller_id = ? AND revoked_at IS NULL AND expires_at > datetime('now') ORDER BY last_used DESC",
            [r.id]
        );
        const [activity] = await db.query(
            'SELECT event, actor, ip, device, created_at FROM activities WHERE reseller_id = ? ORDER BY created_at DESC LIMIT 20',
            [r.id]
        );
        res.json({ totp_enabled: !!r.totp_enabled, devices, trusted_browsers: trusted, activity, current_session_id: req.sessionId });
    } catch (err) {
        console.error('Security status error:', err);
        res.status(500).json({ error: 'Failed to load security status' });
    }
});

router.post('/api/security/totp/setup', auth, requireRole('reseller', 'owner'), async (req, res) => {
    try {
        const secret = speakeasy.generateSecret({ name: `LightningPay (${req.reseller.username})`, length: 20 });
        await db.query('UPDATE resellers SET totp_secret = ?, totp_enabled = 0 WHERE id = ?', [secret.base32, req.reseller.id]);
        await db.query('DELETE FROM trusted_devices WHERE reseller_id = ?', [req.reseller.id]).catch(() => {});
        clearTrustCookie(res);
        const qrUrl = await qrcode.toDataURL(secret.otpauth_url);
        res.json({ secret: secret.base32, qr: qrUrl });
    } catch (err) {
        res.status(500).json({ error: 'Failed to generate 2FA secret' });
    }
});

router.post('/api/security/totp/enable', auth, requireRole('reseller', 'owner'), async (req, res) => {
    try {
        const { code } = req.body;
        const r = req.reseller;
        if (!r.totp_secret) return res.status(400).json({ error: 'Setup TOTP first' });
        const valid = speakeasy.totp.verify({ secret: r.totp_secret, encoding: 'base32', token: code, window: 2 });
        if (!valid) return res.status(400).json({ error: 'Invalid code' });
        await db.query('UPDATE resellers SET totp_enabled = 1 WHERE id = ?', [r.id]);
        await db.query('DELETE FROM trusted_devices WHERE reseller_id = ?', [r.id]).catch(() => {});
        clearTrustCookie(res);
        res.json({ success: true, message: '2FA enabled successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/api/security/totp/disable', auth, requireRole('reseller', 'owner'), async (req, res) => {
    try {
        const { code, current_password } = req.body;
        const r = req.reseller;
        if (!current_password) return res.status(400).json({ error: 'Current password is required to disable 2FA' });
        const [rows] = await db.query('SELECT password FROM resellers WHERE id = ?', [r.id]);
        if (!rows.length) return res.status(404).json({ error: 'Account not found' });
        if (!(await bcrypt.compare(current_password, rows[0].password))) return res.status(403).json({ error: 'Incorrect current password' });
        if (!r.totp_secret) return res.status(400).json({ error: '2FA is not configured' });
        const valid = speakeasy.totp.verify({ secret: r.totp_secret, encoding: 'base32', token: code, window: 2 });
        if (!valid) return res.status(400).json({ error: 'Invalid 2FA code' });

        await db.query('UPDATE resellers SET totp_enabled = 0, totp_secret = NULL WHERE id = ?', [r.id]);
        await db.query('DELETE FROM trusted_devices WHERE reseller_id = ?', [r.id]).catch(() => {});
        clearTrustCookie(res);
        await db.query(
            'INSERT INTO activities (reseller_id, actor, event, ip, device) VALUES (?,?,?,?,?)',
            [r.id, r.username, '2fa_disabled', req.clientIp || req.ip, req.headers['user-agent']]
        );
        res.json({ success: true, message: '2FA disabled' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to disable 2FA' });
    }
});

router.post('/api/security/password', auth, async (req, res) => {
    try {
        const { current_password, new_password, confirm_password } = req.body || {};
        if (!current_password) return res.status(400).json({ error: 'Current password is required' });
        if (!new_password || new_password.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
        if (new_password !== confirm_password) return res.status(400).json({ error: 'Passwords do not match' });
        if (new_password === current_password) return res.status(400).json({ error: 'New password must differ from current password' });

        const isSubUser = !!req.sub_user;
        const targetTable = isSubUser ? 'sub_users' : 'resellers';
        const targetId = isSubUser ? req.sub_user.id : req.reseller.id;
        const [rows] = await db.query(`SELECT password FROM ${targetTable} WHERE id = ?`, [targetId]);
        if (!rows.length) return res.status(404).json({ error: 'Account not found' });
        if (!(await bcrypt.compare(current_password, rows[0].password))) return res.status(403).json({ error: 'Incorrect current password' });

        const hash = await bcrypt.hash(new_password, 12);
        await db.query(`UPDATE ${targetTable} SET password = ?, must_change_password = 0 WHERE id = ?`, [hash, targetId]);

        if (req.tokenHash) {
            const accountType = isSubUser ? 'sub_user' : 'reseller';
            await db.query(
                'DELETE FROM sessions WHERE account_type = ? AND account_id = ? AND token_hash != ?',
                [accountType, targetId, req.tokenHash]
            ).catch(() => {});
        }

        if (!isSubUser) {
            await db.query('DELETE FROM trusted_devices WHERE reseller_id = ?', [req.reseller.id]).catch(() => {});
            clearTrustCookie(res);
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

router.get('/api/security/sessions', auth, requireRole('reseller', 'owner'), async (req, res) => {
    try {
        await db.query("DELETE FROM sessions WHERE account_type = 'reseller' AND account_id = ? AND expires_at <= datetime('now')", [req.reseller.id]).catch(() => {});
        const [sessions] = await db.query(
            "SELECT id, ip, user_agent, device_type, last_active, created_at, expires_at FROM sessions WHERE account_type = 'reseller' AND account_id = ? AND expires_at > datetime('now') ORDER BY last_active DESC",
            [req.reseller.id]
        );
        res.json({ sessions, current_session_id: req.sessionId });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load sessions' });
    }
});

router.delete('/api/security/sessions/:id', auth, requireRole('reseller', 'owner'), async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid session' });
        if (id === Number(req.sessionId)) return res.status(400).json({ error: 'Use Logout to end the current session' });
        const [result] = await db.query(
            "DELETE FROM sessions WHERE id = ? AND account_type = 'reseller' AND account_id = ?",
            [id, req.reseller.id]
        );
        if (!result.affectedRows) return res.status(404).json({ error: 'Session not found' });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to revoke session' });
    }
});

router.delete('/api/security/sessions', auth, requireRole('reseller', 'owner'), async (req, res) => {
    try {
        await db.query(
            "DELETE FROM sessions WHERE account_type = 'reseller' AND account_id = ? AND id != ?",
            [req.reseller.id, req.sessionId]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to revoke other sessions' });
    }
});

router.get('/api/security/trusted-browsers', auth, requireRole('reseller', 'owner'), async (req, res) => {
    try {
        await db.query("DELETE FROM trusted_devices WHERE reseller_id = ? AND expires_at <= datetime('now')", [req.reseller.id]).catch(() => {});
        const [devices] = await db.query(
            "SELECT id, label, ip, user_agent, device_type, created_at, last_used, expires_at FROM trusted_devices WHERE reseller_id = ? AND revoked_at IS NULL AND expires_at > datetime('now') ORDER BY last_used DESC",
            [req.reseller.id]
        );
        res.json({ devices });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load trusted browsers' });
    }
});

router.delete('/api/security/trusted-browsers/:id', auth, requireRole('reseller', 'owner'), async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid trusted browser' });
        const [result] = await db.query('DELETE FROM trusted_devices WHERE id = ? AND reseller_id = ?', [id, req.reseller.id]);
        if (!result.affectedRows) return res.status(404).json({ error: 'Trusted browser not found' });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to remove trusted browser' });
    }
});

router.delete('/api/security/trusted-browsers', auth, requireRole('reseller', 'owner'), async (req, res) => {
    try {
        await db.query('DELETE FROM trusted_devices WHERE reseller_id = ?', [req.reseller.id]);
        clearTrustCookie(res);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to remove trusted browsers' });
    }
});

// Backward-compatible endpoints retained for older clients. They remain scoped to
// reseller-owned sessions only and never reveal sub-user sessions.
router.delete('/api/security/devices/:tokenHash', auth, requireRole('reseller', 'owner'), async (req, res) => {
    try {
        if (req.params.tokenHash === req.tokenHash) return res.status(400).json({ error: 'Cannot remove current device' });
        await db.query(
            "DELETE FROM sessions WHERE token_hash = ? AND account_type = 'reseller' AND account_id = ?",
            [req.params.tokenHash, req.reseller.id]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.delete('/api/security/devices', auth, requireRole('reseller', 'owner'), async (req, res) => {
    try {
        await db.query(
            "DELETE FROM sessions WHERE account_type = 'reseller' AND account_id = ? AND token_hash != ?",
            [req.reseller.id, req.tokenHash]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/api/security/devices', auth, requireRole('reseller', 'owner'), async (req, res) => {
    try {
        const [devices] = await db.query(
            "SELECT *, token_hash as id FROM sessions WHERE account_type = 'reseller' AND account_id = ? AND expires_at > datetime('now') ORDER BY last_active DESC",
            [req.reseller.id]
        );
        res.json({ devices, currentToken: req.tokenHash });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
