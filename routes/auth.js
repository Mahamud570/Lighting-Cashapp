const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const speakeasy = require('speakeasy');
const db = require('../database/db');
const { authLimiter } = require('../middleware/rateLimiter');

// GET /login
router.get('/login', (req, res) => {
    res.sendFile('login.html', { root: './public' });
});

// GET /register
router.get('/register', (req, res) => {
    res.sendFile('register.html', { root: './public' });
});

// POST /api/auth/login
router.post('/api/auth/login', authLimiter, async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

        const [rows] = await db.query(
            "SELECT * FROM resellers WHERE (username = ? OR email = ?) AND status = 'active'",
            [username, username]
        );

        if (!rows.length) return res.status(401).json({ error: 'Invalid credentials' });
        const reseller = rows[0];

        const valid = await bcrypt.compare(password, reseller.password);
        if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

        // 2FA Check — if enabled, require TOTP code before issuing JWT
        if (reseller.totp_enabled && reseller.totp_secret) {
            const { totp_code } = req.body;
            if (!totp_code) {
                // Signal frontend to show 2FA input
                return res.status(200).json({ requires_2fa: true, message: 'Enter your 2FA code' });
            }
            const totpValid = speakeasy.totp.verify({
                secret: reseller.totp_secret,
                encoding: 'base32',
                token: totp_code.replace(/\s/g, ''),
                window: 2
            });
            if (!totpValid) {
                return res.status(401).json({ error: 'Invalid 2FA code. Please try again.' });
            }
        }

        // Create JWT
        const token = jwt.sign(
            { id: reseller.id, username: reseller.username },
            process.env.JWT_SECRET || 'secret',
            { expiresIn: '7d' }
        );

        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

        // Detect device
        const ua = req.headers['user-agent'] || '';
        const deviceType = /mobile/i.test(ua) ? 'Mobile' : 'Desktop';

        // Save session
        await db.query(
            'INSERT INTO sessions (reseller_id, token_hash, ip, user_agent, device_type, expires_at) VALUES (?,?,?,?,?,?)',
            [reseller.id, tokenHash, req.ip, ua, deviceType, expiresAt]
        );

        // Log activity
        await db.query(
            'INSERT INTO activities (reseller_id, actor, event, ip, device) VALUES (?,?,?,?,?)',
            [reseller.id, reseller.username, 'login', req.ip, ua]
        );

        res.cookie('auth_token', token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            maxAge: 7 * 24 * 60 * 60 * 1000,
            sameSite: 'lax'
        });

        res.json({ success: true, redirect: '/reseller' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// POST /api/auth/register
router.post('/api/auth/register', authLimiter, async (req, res) => {
    try {
        const { username, email, password } = req.body;
        if (!username || !email || !password) return res.status(400).json({ error: 'All fields required' });
        if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

        const [existing] = await db.query('SELECT id FROM resellers WHERE username = ? OR email = ?', [username, email]);
        if (existing.length) return res.status(400).json({ error: 'Username or email already taken' });

        const hash = await bcrypt.hash(password, 12);
        await db.query('INSERT INTO resellers (username, email, password) VALUES (?,?,?)', [username, email, hash]);

        res.json({ success: true, redirect: '/login' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// POST /api/auth/logout
router.post('/api/auth/logout', async (req, res) => {
    const token = req.cookies?.auth_token;
    if (token) {
        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
        await db.query('DELETE FROM sessions WHERE token_hash = ?', [tokenHash]).catch(() => {});
    }
    res.clearCookie('auth_token');
    res.json({ success: true });
});

module.exports = router;
