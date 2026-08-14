const express = require('express');
const router = express.Router();
const db = require('../database/db');
const auth = require('../middleware/auth');

// GET /api/dashboard/stats
router.get('/api/dashboard/stats', auth, async (req, res) => {
    try {
        const rid = req.reseller.id;

        const [linksRows] = await db.query('SELECT COUNT(*) as count FROM payment_links WHERE reseller_id = ?', [rid]);
        const [clicksRows] = await db.query('SELECT COALESCE(SUM(clicks),0) as total FROM payment_links WHERE reseller_id = ?', [rid]);
        const [paidRows] = await db.query('SELECT COALESCE(SUM(total_usd),0) as total FROM payments WHERE reseller_id = ? AND status="paid"', [rid]);
        const [pendingRows] = await db.query('SELECT COUNT(*) as count FROM payments WHERE reseller_id = ? AND status="pending"', [rid]);
        const [expiredRows] = await db.query('SELECT COUNT(*) as count FROM payments WHERE reseller_id = ? AND status="expired"', [rid]);

        const links = linksRows[0] || { count: 0 };
        const clicks = clicksRows[0] || { total: 0 };
        const paid = paidRows[0] || { total: 0 };
        const pending = pendingRows[0] || { count: 0 };
        const expired = expiredRows[0] || { count: 0 };

        const [paid7dRows] = await db.query(
            "SELECT COALESCE(SUM(total_usd),0) as total FROM payments WHERE reseller_id = ? AND status='paid' AND paid_at >= datetime('now', '-7 days')",
            [rid]
        );
        const [paid30dRows] = await db.query(
            "SELECT COALESCE(SUM(total_usd),0) as total FROM payments WHERE reseller_id = ? AND status='paid' AND paid_at >= datetime('now', '-30 days')",
            [rid]
        );
        const paid7d = paid7dRows[0] || { total: 0 };
        const paid30d = paid30dRows[0] || { total: 0 };

        // Conversion rate
        const [totalInvRows] = await db.query('SELECT COUNT(*) as count FROM payments WHERE reseller_id = ?', [rid]);
        const totalInvoices = totalInvRows[0] || { count: 0 };
        const conversion = totalInvoices.count > 0 ? Math.round((paid.total / totalInvoices.count) * 100) : 0;

        // Top links
        const [topLinks] = await db.query(
            'SELECT slug, title, fixed_amount, clicks, (SELECT COUNT(*) FROM payments p WHERE p.link_id = pl.id) as invoices, status FROM payment_links pl WHERE pl.reseller_id = ? ORDER BY clicks DESC LIMIT 5',
            [rid]
        );

        // Recent payments
        const [recentPayments] = await db.query(
            'SELECT p.*, pl.slug, pl.title FROM payments p LEFT JOIN payment_links pl ON p.link_id = pl.id WHERE p.reseller_id = ? ORDER BY p.created_at DESC LIMIT 10',
            [rid]
        );

        // Recent clicks
        const [recentClicks] = await db.query(
            'SELECT lc.*, pl.slug FROM link_clicks lc LEFT JOIN payment_links pl ON lc.link_id = pl.id WHERE pl.reseller_id = ? ORDER BY lc.clicked_at DESC LIMIT 10',
            [rid]
        );

        // Wallet status
        const r = req.reseller;
        const walletStatus = r.wallet_type ? 'active' : 'inactive';

        res.json({
            links: links.count,
            clicks: clicks.total,
            paid_usd: parseFloat(paid.total).toFixed(2),
            pending: pending.count,
            expired: expired.count,
            paid_7d: parseFloat(paid7d.total).toFixed(2),
            paid_30d: parseFloat(paid30d.total).toFixed(2),
            conversion,
            top_links: topLinks,
            recent_payments: recentPayments,
            recent_clicks: recentClicks,
            wallet_status: walletStatus,
            wallet_type: r.wallet_type
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = router;
