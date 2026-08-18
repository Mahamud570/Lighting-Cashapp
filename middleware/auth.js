const jwt = require('jsonwebtoken');
const db = require('../database/db');
const crypto = require('crypto');

const isApiPath = (req) => {
    if (typeof req === 'string') return req.startsWith('/api/') || req.includes('/api/');
    const url = req.originalUrl || req.url || req.path || '';
    const accept = req.headers ? req.headers['accept'] : '';
    return url.includes('/api/') || (accept && accept.includes('application/json'));
};

const getClientIp = (req) => {
    if (process.env.TRUST_PROXY === '1') {
        const forwarded = req.headers['x-forwarded-for'];
        if (forwarded) return forwarded.split(',')[0].trim();
    }
    return req.ip || req.socket?.remoteAddress || 'unknown';
};

const authMiddleware = async (req, res, next) => {
    req.clientIp = getClientIp(req);

    try {
        const token = req.cookies?.auth_token || req.headers['authorization']?.replace('Bearer ', '');
        if (!token) {
            if (isApiPath(req)) return res.status(401).json({ error: 'Unauthorized' });
            return res.redirect('/login');
        }

        const jwtSecret = process.env.JWT_SECRET;
        if (!jwtSecret) throw new Error('JWT_SECRET environment variable is missing');

        const decoded = jwt.verify(token, jwtSecret);
        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

        const [sessions] = await db.query(
            "SELECT id FROM sessions WHERE token_hash = ? AND expires_at > datetime('now')",
            [tokenHash]
        );
        if (!sessions.length) {
            res.clearCookie('auth_token');
            if (isApiPath(req)) return res.status(401).json({ error: 'Session expired' });
            return res.redirect('/login');
        }

        await db.query("UPDATE sessions SET last_active = datetime('now') WHERE token_hash = ?", [tokenHash]);

        if (decoded.type === 'sub_user' || decoded.role === 'sub_user') {
            const [subUsers] = await db.query(
                "SELECT id, reseller_id, name, email, rate_per_dollar, charge_mode, charge_value, status, balance_usd, must_change_password FROM sub_users WHERE id = ? AND status = 'active'",
                [decoded.id]
            );

            if (!subUsers.length) {
                res.clearCookie('auth_token');
                if (isApiPath(req)) return res.status(401).json({ error: 'Sub-user account inactive' });
                return res.redirect('/login');
            }

            const subUser = subUsers[0];
            req.sub_user = subUser;
            req.role = 'sub_user';
            req.reseller = {
                id: subUser.reseller_id,
                role: 'sub_user',
                username: subUser.name,
                must_change_password: 0
            };
        } else {
            const [resellers] = await db.query(
                `SELECT id, username, email, role, wallet_type, wallet_email,
                        opennode_api_key, opennode_env,
                        btcpay_url, btcpay_store_id, btcpay_api_key,
                        btcpay_webhook_id, btcpay_webhook_secret,
                        lnbits_url, lnbits_invoice_key, lnbits_admin_key,
                        blink_api_key, blink_api_keys, blink_wallet_id,
                        alby_nwc_string, alby_access_token, alby_webhook_secret,
                        binance_api_key, binance_api_secret,
                        binance_auto_sweep_enabled, binance_sweep_threshold_usd,
                        binance_sweep_type, binance_sweep_wallet_balance_enabled,
                        auto_payout_enabled, auto_payout_address, auto_payout_percent,
                        charge_mode, charge_value, status,
                        totp_enabled, totp_secret,
                        telegram_bot_token, telegram_chat_id, must_change_password
                 FROM resellers WHERE id = ? AND status = 'active'`,
                [decoded.id]
            );

            if (!resellers.length) {
                res.clearCookie('auth_token');
                if (isApiPath(req)) return res.status(401).json({ error: 'Account inactive' });
                return res.redirect('/login');
            }

            const reseller = resellers[0];
            req.reseller = reseller;
            req.role = reseller.role || 'reseller';
        }

        req.token = token;
        req.tokenHash = tokenHash;

        // Sub-users never receive the reseller/owner forced-password workflow.
        // Resellers/owners retain the existing security policy.
        if (req.role !== 'sub_user' && req.reseller.must_change_password === 1) {
            const allowedPaths = ['/force-password-change', '/api/security/password', '/api/auth/logout'];
            if (!allowedPaths.includes(req.path)) {
                if (isApiPath(req)) {
                    return res.status(403).json({ error: 'Password change required', requires_password_change: true });
                }
                return res.redirect('/force-password-change');
            }
        }

        next();
    } catch (err) {
        res.clearCookie('auth_token');
        if (isApiPath(req)) return res.status(401).json({ error: 'Invalid token' });
        return res.redirect('/login');
    }
};

const requireRole = (...allowedRoles) => (req, res, next) => {
    const userRole = req.role || req.reseller?.role || 'reseller';
    if (!allowedRoles.includes(userRole)) {
        if (isApiPath(req)) return res.status(403).json({ error: 'Forbidden: Insufficient privileges' });
        return res.redirect(userRole === 'owner' ? '/owner' : '/reseller');
    }
    next();
};

authMiddleware.requireRole = requireRole;
module.exports = authMiddleware;
