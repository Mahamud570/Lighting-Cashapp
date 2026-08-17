const express = require('express');
const router = express.Router();
const speakeasy = require('speakeasy');
const QRCode = require('qrcode');
const db = require('../database/db');
const auth = require('../middleware/auth');
const { totpLimiter } = require('../middleware/rateLimiter');

/**
 * 2FA (TOTP) Routes
 * GET  /api/2fa/setup     — Generate new TOTP secret & QR code
 * POST /api/2fa/verify    — Verify & enable 2FA
 * POST /api/2fa/disable   — Disable 2FA
 * POST /api/2fa/validate  — Validate code during login
 */

// GET /api/2fa/setup — Generate secret & return QR code
router.get('/api/2fa/setup', auth, async (req, res) => {
    try {
        const [rows] = await db.query('SELECT username, email, totp_enabled FROM resellers WHERE id = ?', [req.reseller.id]);
        if (!rows.length) return res.status(404).json({ error: 'User not found' });
        const reseller = rows[0];

        if (reseller.totp_enabled) {
            return res.status(400).json({ error: '2FA is already enabled. Disable it first to reset.' });
        }

        // Generate TOTP secret
        const secret = speakeasy.generateSecret({
            name: `CashPay (${reseller.username})`,
            issuer: 'Lightning Cash App',
            length: 32
        });

        // Store temp secret (not enabled yet)
        await db.query('UPDATE resellers SET totp_secret = ? WHERE id = ?', [secret.base32, req.reseller.id]);

        // Generate QR code as data URL
        const qrDataUrl = await QRCode.toDataURL(secret.otpauth_url);

        res.json({
            success: true,
            secret: secret.base32,
            qr_code: qrDataUrl,
            otpauth_url: secret.otpauth_url
        });
    } catch (err) {
        console.error('2FA setup error:', err);
        res.status(500).json({ error: 'Failed to generate 2FA secret' });
    }
});

// POST /api/2fa/verify — Confirm code & activate 2FA
router.post('/api/2fa/verify', auth, totpLimiter, async (req, res) => {
    try {
        const { code } = req.body;
        if (!code) return res.status(400).json({ error: 'TOTP code required' });

        const [rows] = await db.query('SELECT totp_secret FROM resellers WHERE id = ?', [req.reseller.id]);
        if (!rows.length || !rows[0].totp_secret) {
            return res.status(400).json({ error: 'No 2FA setup in progress. Start setup first.' });
        }

        const verified = speakeasy.totp.verify({
            secret: rows[0].totp_secret,
            encoding: 'base32',
            token: code.replace(/\s/g, ''),
            window: 2  // Allow 2 periods for clock drift
        });

        if (!verified) {
            return res.status(401).json({ error: 'Invalid code. Please try again.' });
        }

        await db.query('UPDATE resellers SET totp_enabled = 1 WHERE id = ?', [req.reseller.id]);
        res.json({ success: true, message: '2FA enabled successfully!' });
    } catch (err) {
        console.error('2FA verify error:', err);
        res.status(500).json({ error: 'Verification failed' });
    }
});

// POST /api/2fa/disable — Turn off 2FA (requires current code)
router.post('/api/2fa/disable', auth, totpLimiter, async (req, res) => {
    try {
        const { code } = req.body;
        if (!code) return res.status(400).json({ error: 'Current TOTP code required to disable 2FA' });

        const [rows] = await db.query('SELECT totp_secret, totp_enabled FROM resellers WHERE id = ?', [req.reseller.id]);
        if (!rows.length || !rows[0].totp_enabled) {
            return res.status(400).json({ error: '2FA is not currently enabled' });
        }

        const verified = speakeasy.totp.verify({
            secret: rows[0].totp_secret,
            encoding: 'base32',
            token: code.replace(/\s/g, ''),
            window: 2
        });

        if (!verified) {
            return res.status(401).json({ error: 'Invalid code. 2FA not disabled.' });
        }

        await db.query('UPDATE resellers SET totp_enabled = 0, totp_secret = NULL WHERE id = ?', [req.reseller.id]);
        res.json({ success: true, message: '2FA disabled successfully.' });
    } catch (err) {
        console.error('2FA disable error:', err);
        res.status(500).json({ error: 'Failed to disable 2FA' });
    }
});

// POST /api/2fa/validate — Used during login flow to validate code
router.post('/api/2fa/validate', totpLimiter, async (req, res) => {
    try {
        const { username, code } = req.body;
        if (!username || !code) return res.status(400).json({ error: 'Username and code required' });

        const [rows] = await db.query(
            "SELECT id, totp_secret, totp_enabled FROM resellers WHERE (username = ? OR email = ?) AND status = 'active'",
            [username, username]
        );

        if (!rows.length || !rows[0].totp_enabled || !rows[0].totp_secret) {
            return res.status(400).json({ error: '2FA not configured for this account' });
        }

        const verified = speakeasy.totp.verify({
            secret: rows[0].totp_secret,
            encoding: 'base32',
            token: code.replace(/\s/g, ''),
            window: 2
        });

        if (!verified) {
            return res.status(401).json({ error: 'Invalid 2FA code' });
        }

        res.json({ success: true, valid: true });
    } catch (err) {
        console.error('2FA validate error:', err);
        res.status(500).json({ error: 'Validation failed' });
    }
});

// GET /api/2fa/status — Check if 2FA is enabled
router.get('/api/2fa/status', auth, async (req, res) => {
    try {
        const [rows] = await db.query('SELECT totp_enabled FROM resellers WHERE id = ?', [req.reseller.id]);
        res.json({ enabled: rows[0]?.totp_enabled === 1 });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch 2FA status' });
    }
});

module.exports = router;
