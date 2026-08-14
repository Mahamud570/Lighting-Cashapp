const jwt = require('jsonwebtoken');
const db = require('../database/db');
const crypto = require('crypto');

const authMiddleware = async (req, res, next) => {
    try {
        const token = req.cookies?.auth_token || req.headers['authorization']?.replace('Bearer ', '');

        if (!token) {
            if (req.path.startsWith('/api/')) {
                return res.status(401).json({ error: 'Unauthorized' });
            }
            return res.redirect('/login');
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret');
        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

        // Validate session exists in DB
        const [sessions] = await db.query(
            'SELECT * FROM sessions WHERE token_hash = ? AND reseller_id = ? AND expires_at > datetime(\'now\')',
            [tokenHash, decoded.id]
        );

        if (!sessions.length) {
            res.clearCookie('auth_token');
            if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Session expired' });
            return res.redirect('/login');
        }

        // Update last active
        await db.query('UPDATE sessions SET last_active = NOW() WHERE token_hash = ?', [tokenHash]);

        const [resellers] = await db.query("SELECT * FROM resellers WHERE id = ? AND status = 'active'", [decoded.id]);
        if (!resellers.length) {
            res.clearCookie('auth_token');
            return res.redirect('/login');
        }

        req.reseller = resellers[0];
        req.token = token;
        req.tokenHash = tokenHash;
        next();
    } catch (err) {
        res.clearCookie('auth_token');
        if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Invalid token' });
        return res.redirect('/login');
    }
};

module.exports = authMiddleware;
