const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const crypto = require('crypto');
const speakeasy = require('speakeasy');
const db = require('../database/db');
const { authLimiter } = require('../middleware/rateLimiter');

const TRUST_COOKIE = 'trusted_browser';
const TRUST_DAYS = 30;

function sha256(value) {
    return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function deviceTypeFromUa(ua) {
    return /mobile|android|iphone|ipad/i.test(ua || '') ? 'Mobile' : 'Desktop';
}

function browserLabel(ua) {
    const s = ua || '';
    const browser = /Edg\//.test(s) ? 'Edge' : /Firefox\//.test(s) ? 'Firefox' : /Chrome\//.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : 'Browser';
    const os = /Android/.test(s) ? 'Android' : /iPhone|iPad/.test(s) ? 'iOS' : /Windows/.test(s) ? 'Windows' : /Mac OS X|Macintosh/.test(s) ? 'macOS' : /Linux/.test(s) ? 'Linux' : 'Device';
    return `${browser} on ${os}`;
}

router.get('/login', (req, res) => {
    res.sendFile('login.html', { root: path.join(__dirname, '../public') });
});

router.get('/register', (req, res) => {
    res.redirect('/login');
});

router.post('/api/auth/login', authLimiter, async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

        const cleanUser = String(username).trim();
        const cleanPass = String(password).trim();

        const [rows] = await db.query(
            "SELECT * FROM resellers WHERE (LOWER(TRIM(username)) = LOWER(?) OR LOWER(TRIM(email)) = LOWER(?)) AND (status IS NULL OR LOWER(status) = 'active')",
            [cleanUser, cleanUser]
        );

        let userObj = null;
        let role = 'reseller';
        let isSubUser = false;

        if (rows.length) {
            userObj = rows[0];
            role = userObj.role || 'reseller';
        } else {
            const [subRows] = await db.query(
                "SELECT * FROM sub_users WHERE (LOWER(TRIM(email)) = LOWER(?) OR LOWER(TRIM(name)) = LOWER(?)) AND (status IS NULL OR LOWER(status) = 'active')",
                [cleanUser, cleanUser]
            );
            if (subRows.length) {
                userObj = subRows[0];
                role = 'sub_user';
                isSubUser = true;
            }
        }

        if (!userObj) return res.status(401).json({ error: 'Invalid credentials' });

        const valid = await bcrypt.compare(cleanPass, userObj.password);
        if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

        const ua = req.headers['user-agent'] || '';
        const ip = req.clientIp || req.ip;
        let trustedBrowserValid = false;

        // Reseller/owner trusted browser lookup. Sub-users do not use this 2FA flow.
        if (!isSubUser && userObj.totp_enabled && userObj.totp_secret && req.cookies?.[TRUST_COOKIE]) {
            const trustHash = sha256(req.cookies[TRUST_COOKIE]);
            const [trustedRows] = await db.query(
                "SELECT id FROM trusted_devices WHERE reseller_id = ? AND token_hash = ? AND revoked_at IS NULL AND expires_at > datetime('now') LIMIT 1",
                [userObj.id, trustHash]
            );
            if (trustedRows.length) {
                trustedBrowserValid = true;
                await db.query(
                    "UPDATE trusted_devices SET last_used = datetime('now'), ip = ?, user_agent = ?, device_type = ? WHERE id = ?",
                    [ip, ua, deviceTypeFromUa(ua), trustedRows[0].id]
                );
            } else {
                res.clearCookie(TRUST_COOKIE, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax' });
            }
        }

        // 2FA is required only if this browser is not already trusted.
        if (!isSubUser && userObj.totp_enabled && userObj.totp_secret && !trustedBrowserValid) {
            const { totp_code } = req.body;
            if (!totp_code) {
                return res.status(200).json({ requires_2fa: true, can_trust_browser: true, message: 'Enter your 2FA code' });
            }
            const totpValid = speakeasy.totp.verify({
                secret: userObj.totp_secret,
                encoding: 'base32',
                token: String(totp_code).replace(/\s/g, ''),
                window: 2
            });
            if (!totpValid) return res.status(401).json({ error: 'Invalid 2FA code. Please try again.' });

            if (req.body.trust_browser === true || req.body.trust_browser === 'true') {
                const rawTrustToken = crypto.randomBytes(48).toString('base64url');
                const trustHash = sha256(rawTrustToken);
                const expiresAt = new Date(Date.now() + TRUST_DAYS * 24 * 60 * 60 * 1000);
                await db.query(
                    `INSERT INTO trusted_devices (reseller_id, token_hash, label, ip, user_agent, device_type, expires_at)
                     VALUES (?,?,?,?,?,?,?)`,
                    [userObj.id, trustHash, browserLabel(ua), ip, ua, deviceTypeFromUa(ua), expiresAt]
                );
                res.cookie(TRUST_COOKIE, rawTrustToken, {
                    httpOnly: true,
                    secure: process.env.NODE_ENV === 'production',
                    sameSite: 'lax',
                    maxAge: TRUST_DAYS * 24 * 60 * 60 * 1000
                });
            }
        }

        const jwtSecret = process.env.JWT_SECRET;
        if (!jwtSecret) throw new Error('JWT_SECRET environment variable is missing');

        const payload = isSubUser
            ? { id: userObj.id, username: userObj.name, role: 'sub_user', type: 'sub_user', reseller_id: userObj.reseller_id }
            : { id: userObj.id, username: userObj.username, role, type: 'reseller' };

        const token = jwt.sign(payload, jwtSecret, { expiresIn: '7d' });
        const tokenHash = sha256(token);
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        const resellerId = isSubUser ? userObj.reseller_id : userObj.id;

        await db.query(
            'INSERT INTO sessions (reseller_id, token_hash, ip, user_agent, device_type, expires_at) VALUES (?,?,?,?,?,?)',
            [resellerId, tokenHash, ip, ua, deviceTypeFromUa(ua), expiresAt]
        );

        await db.query(
            'INSERT INTO activities (reseller_id, sub_user_id, actor, event, ip, device) VALUES (?,?,?,?,?,?)',
            [resellerId, isSubUser ? userObj.id : null, isSubUser ? userObj.name : userObj.username, trustedBrowserValid ? 'login_trusted_browser' : 'login', ip, ua]
        );

        res.cookie('auth_token', token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            maxAge: 7 * 24 * 60 * 60 * 1000,
            sameSite: 'lax'
        });

        const redirectUrl = role === 'owner' ? '/owner' : (role === 'sub_user' ? '/subuser' : '/reseller');
        res.json({ success: true, role, redirect: redirectUrl, trusted_browser: trustedBrowserValid });
    } catch (err) {
        console.error('[auth] Login error:', err && err.stack ? err.stack : err);
        res.status(500).json({ error: 'Server error' });
    }
});

router.post('/api/auth/register', (req, res) => {
    res.status(403).json({ error: 'Public registration is disabled. Accounts must be created by an Owner or Reseller.' });
});

router.post('/api/auth/logout', async (req, res) => {
    const token = req.cookies?.auth_token;
    if (token) {
        const tokenHash = sha256(token);
        await db.query('DELETE FROM sessions WHERE token_hash = ?', [tokenHash]).catch(() => {});
    }
    // Deliberately keep trusted_browser cookie. Logout ends the session but the browser remains trusted.
    res.clearCookie('auth_token');
    res.json({ success: true });
});

module.exports = router;
