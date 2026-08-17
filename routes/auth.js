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

        // 1. Try Resellers / Owners table first
        const [rows] = await db.query(
            "SELECT * FROM resellers WHERE (username = ? OR email = ?) AND status = 'active'",
            [username, username]
        );

        let userObj = null;
        let role = 'reseller';
        let isSubUser = false;

        if (rows.length) {
            userObj = rows[0];
            role = userObj.role || 'reseller';
        } else {
            // 2. Try Sub-users table if not found in resellers
            const [subRows] = await db.query(
                "SELECT * FROM sub_users WHERE (email = ? OR name = ?) AND status = 'active'",
                [username, username]
            );
            if (subRows.length) {
                userObj = subRows[0];
                role = 'sub_user';
                isSubUser = true;
            }
        }

        if (!userObj) return res.status(401).json({ error: 'Invalid credentials' });

        const valid = await bcrypt.compare(password, userObj.password);
        if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

        // 2FA Check — for reseller/owner accounts if enabled
        if (!isSubUser && userObj.totp_enabled && userObj.totp_secret) {
            const { totp_code } = req.body;
            if (!totp_code) {
                return res.status(200).json({ requires_2fa: true, message: 'Enter your 2FA code' });
            }
            const totpValid = speakeasy.totp.verify({
                secret: userObj.totp_secret,
                encoding: 'base32',
                token: totp_code.replace(/\s/g, ''),
                window: 2
            });
            if (!totpValid) {
                return res.status(401).json({ error: 'Invalid 2FA code. Please try again.' });
            }
        }

        // Create JWT with role info
        const jwtSecret = process.env.JWT_SECRET;
        if (!jwtSecret) {
            return res.status(500).json({ error: 'Server configuration error' });
        }

        const payload = isSubUser
            ? { id: userObj.id, username: userObj.name, role: 'sub_user', type: 'sub_user', reseller_id: userObj.reseller_id }
            : { id: userObj.id, username: userObj.username, role: role, type: 'reseller' };

        const token = jwt.sign(payload, jwtSecret, { expiresIn: '7d' });
        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

        // Detect device
        const ua = req.headers['user-agent'] || '';
        const deviceType = /mobile/i.test(ua) ? 'Mobile' : 'Desktop';
        const resellerId = isSubUser ? userObj.reseller_id : userObj.id;

        // Save session
        await db.query(
            'INSERT INTO sessions (reseller_id, token_hash, ip, user_agent, device_type, expires_at) VALUES (?,?,?,?,?,?)',
            [resellerId, tokenHash, req.clientIp || req.ip, ua, deviceType, expiresAt]
        );

        // Log activity
        await db.query(
            'INSERT INTO activities (reseller_id, sub_user_id, actor, event, ip, device) VALUES (?,?,?,?,?,?)',
            [resellerId, isSubUser ? userObj.id : null, isSubUser ? userObj.name : userObj.username, 'login', req.clientIp || req.ip, ua]
        );

        res.cookie('auth_token', token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            maxAge: 7 * 24 * 60 * 60 * 1000,
            sameSite: 'lax'
        });

        const redirectUrl = role === 'owner' ? '/owner' : (role === 'sub_user' ? '/subuser' : '/reseller');
        res.json({ success: true, role, redirect: redirectUrl });
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
        // S-011 FIX: Raise minimum password length to 8 (NIST SP 800-63B)
        if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

        // Sanitize: username must be alphanumeric/underscore, 3-30 chars
        if (!/^[a-zA-Z0-9_]{3,30}$/.test(username)) {
            return res.status(400).json({ error: 'Username must be 3–30 characters (letters, numbers, underscore only)' });
        }

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
