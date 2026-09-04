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

function trustCookieOptions() {
    return {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: TRUST_DAYS * 24 * 60 * 60 * 1000,
        path: '/'
    };
}

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
        const cleanPass = String(password);

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

        if (!isSubUser && userObj.totp_enabled && userObj.totp_secret && req.cookies?.[TRUST_COOKIE]) {
            const trustHash = sha256(req.cookies[TRUST_COOKIE]);
            const [trustedRows] = await db.query(
                "SELECT id FROM trusted_devices WHERE reseller_id = ? AND token_hash = ? AND revoked_at IS NULL AND expires_at > datetime('now') LIMIT 1",
                [userObj.id, trustHash]
            );
            if (trustedRows.length) {
                trustedBrowserValid = true;
                const trustExpiresAt = new Date(Date.now() + TRUST_DAYS * 24 * 60 * 60 * 1000);
                await db.query(
                    "UPDATE trusted_devices SET last_used = datetime('now'), expires_at = ?, ip = ?, user_agent = ?, device_type = ? WHERE id = ?",
                    [trustExpiresAt, ip, ua, deviceTypeFromUa(ua), trustedRows[0].id]
                );
                // Refresh the browser token as a rolling 30-day trust period.
                res.cookie(TRUST_COOKIE, req.cookies[TRUST_COOKIE], trustCookieOptions());
            } else {
                res.clearCookie(TRUST_COOKIE, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax' });
            }
        }

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
                const trustExpiresAt = new Date(Date.now() + TRUST_DAYS * 24 * 60 * 60 * 1000);
                await db.query(
                    `INSERT INTO trusted_devices (reseller_id, token_hash, label, ip, user_agent, device_type, expires_at)
                     VALUES (?,?,?,?,?,?,?)`,
                    [userObj.id, trustHash, browserLabel(ua), ip, ua, deviceTypeFromUa(ua), trustExpiresAt]
                );
                res.cookie(TRUST_COOKIE, rawTrustToken, trustCookieOptions());
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
        const accountType = isSubUser ? 'sub_user' : 'reseller';
        const accountId = userObj.id;

        await db.query(
            'INSERT INTO sessions (reseller_id, account_type, account_id, token_hash, ip, user_agent, device_type, expires_at) VALUES (?,?,?,?,?,?,?,?)',
            [resellerId, accountType, accountId, tokenHash, ip, ua, deviceTypeFromUa(ua), expiresAt]
        );

        await db.query(
            'INSERT INTO activities (reseller_id, sub_user_id, actor, event, ip, device) VALUES (?,?,?,?,?,?)',
            [resellerId, isSubUser ? userObj.id : null, isSubUser ? userObj.name : userObj.username, trustedBrowserValid ? 'login_trusted_browser' : 'login', ip, ua]
        );

        res.cookie('auth_token', token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            maxAge: 7 * 24 * 60 * 60 * 1000,
            sameSite: 'lax',
            path: '/',
            priority: 'high'
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

router.post('/api/auth/exit-preview', async (req, res) => {
    try {
        const returnToken = req.cookies?.owner_return_token;
        if (!returnToken) return res.status(401).json({ error: 'Owner preview session has expired' });
        const decoded = jwt.verify(returnToken, process.env.JWT_SECRET);
        if (decoded.role !== 'owner') return res.status(403).json({ error: 'Invalid owner preview session' });
        const returnHash = sha256(returnToken);
        const [sessions] = await db.query("SELECT id FROM sessions WHERE token_hash=? AND account_type='reseller' AND account_id=? AND expires_at > datetime('now')", [returnHash, decoded.id]);
        const [owners] = await db.query("SELECT id FROM resellers WHERE id=? AND role='owner' AND status='active'", [decoded.id]);
        if (!sessions.length || !owners.length) return res.status(401).json({ error: 'Owner session is no longer active' });

        const currentToken = req.cookies?.auth_token;
        if (currentToken) await db.query('DELETE FROM sessions WHERE token_hash=?', [sha256(currentToken)]).catch(() => {});
        res.cookie('auth_token', returnToken, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'lax',
            maxAge: 7 * 24 * 60 * 60 * 1000,
            path: '/',
            priority: 'high'
        });
        res.clearCookie('owner_return_token', { path: '/' });
        res.json({ success: true, redirect: '/owner' });
    } catch (err) {
        res.clearCookie('owner_return_token', { path: '/' });
        res.status(401).json({ error: 'Owner preview session has expired' });
    }
});

router.post('/api/auth/logout', async (req, res) => {
    try {
        const token = req.cookies?.auth_token;
        if (token) {
            const tokenHash = sha256(token);
            // Logout revokes only this session. It must never alter wallet,
            // reseller, staff, link, or platform configuration rows.
            await db.query('DELETE FROM sessions WHERE token_hash = ?', [tokenHash]);
        }
        res.clearCookie('auth_token', { path: '/' });
        res.clearCookie('owner_return_token', { path: '/' });
        res.json({ success: true });
    } catch (err) {
        console.error('[auth] Logout session persistence failed:', err.message);
        res.status(503).json({ error: 'Logout could not be saved because database storage is unavailable. Your settings were not changed.' });
    }
});

module.exports = router;
