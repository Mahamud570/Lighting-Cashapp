const express = require('express');
const router = express.Router();
const db = require('../database/db');
const auth = require('../middleware/auth');
const { requireRole } = auth;

router.use('/api/analytics*', auth, requireRole('reseller', 'owner'));

/**
 * Analytics API Routes
 *
 * GET /api/analytics/overview  — Total revenue, counts, growth
 * GET /api/analytics/chart     — Daily revenue data for chart (period clamped 7–90 days)
 * GET /api/analytics/top-links — Top payment links by volume
 * GET /api/analytics/recent    — Recent paid transactions
 *
 * FIXES APPLIED:
 *  - BUG-001: All handlers used `req.user.id` — auth middleware sets `req.reseller`.
 *             Corrected to `req.reseller.id` throughout.
 *  - BUG-002: Chart query used string interpolation (`-${days} days`) inside SQL.
 *             Now uses a safe parameterised binding passed to datetime('now', ?).
 */

// ─── GET /api/analytics/overview ─────────────────────────────────────────────
router.get('/api/analytics/overview', auth, async (req, res) => {
    try {
        const id = req.reseller.id; // FIX BUG-001: was req.user.id

        const [[totals]] = await db.query(`
            SELECT
                COALESCE(SUM(CASE WHEN status='paid' THEN total_usd ELSE 0 END), 0) AS total_revenue,
                COUNT(CASE WHEN status='paid' THEN 1 END)                            AS total_paid,
                COUNT(*)                                                              AS total_invoices,
                COALESCE(AVG(CASE WHEN status='paid' THEN total_usd END), 0)         AS avg_order
            FROM payments WHERE reseller_id = ?
        `, [id]);

        const [[today]] = await db.query(`
            SELECT COALESCE(SUM(total_usd), 0) AS revenue, COUNT(*) AS count
            FROM payments
            WHERE reseller_id = ? AND status = 'paid'
              AND date(paid_at) = date('now')
        `, [id]);

        const [[week]] = await db.query(`
            SELECT COALESCE(SUM(total_usd), 0) AS revenue, COUNT(*) AS count
            FROM payments
            WHERE reseller_id = ? AND status = 'paid'
              AND paid_at >= datetime('now', '-7 days')
        `, [id]);

        const [[month]] = await db.query(`
            SELECT COALESCE(SUM(total_usd), 0) AS revenue, COUNT(*) AS count
            FROM payments
            WHERE reseller_id = ? AND status = 'paid'
              AND paid_at >= datetime('now', '-30 days')
        `, [id]);

        // Previous 7-day window for week-over-week growth calculation
        const [[prevWeek]] = await db.query(`
            SELECT COALESCE(SUM(total_usd), 0) AS revenue
            FROM payments
            WHERE reseller_id = ? AND status = 'paid'
              AND paid_at >= datetime('now', '-14 days')
              AND paid_at <  datetime('now', '-7 days')
        `, [id]);

        const [[sweepTotals]] = await db.query(`
            SELECT
                COUNT(CASE WHEN status='completed' THEN 1 END) AS swept,
                COUNT(CASE WHEN status='held' THEN 1 END)      AS held,
                COUNT(CASE WHEN status='failed' THEN 1 END)    AS failed,
                COALESCE(SUM(CASE WHEN status='completed' THEN amount_usd ELSE 0 END), 0) AS swept_usd
            FROM auto_sweeps WHERE reseller_id = ?
        `, [id]);

        const weekGrowth = prevWeek.revenue > 0
            ? (((week.revenue - prevWeek.revenue) / prevWeek.revenue) * 100).toFixed(1)
            : (week.revenue > 0 ? 100 : 0);

        res.json({
            total_revenue:  parseFloat(totals.total_revenue).toFixed(2),
            total_paid:     totals.total_paid,
            total_invoices: totals.total_invoices,
            avg_order:      parseFloat(totals.avg_order).toFixed(2),
            today:  { revenue: parseFloat(today.revenue).toFixed(2), count: today.count },
            week:   { revenue: parseFloat(week.revenue).toFixed(2),  count: week.count, growth: parseFloat(weekGrowth) },
            month:  { revenue: parseFloat(month.revenue).toFixed(2), count: month.count },
            sweeps: {
                swept:     sweepTotals.swept,
                held:      sweepTotals.held,
                failed:    sweepTotals.failed,
                swept_usd: parseFloat(sweepTotals.swept_usd).toFixed(2)
            }
        });
    } catch (err) {
        console.error('Analytics overview error:', err);
        res.status(500).json({ error: 'Failed to load analytics' });
    }
});

// ─── GET /api/analytics/chart?period=7|30|90 ─────────────────────────────────
router.get('/api/analytics/chart', auth, async (req, res) => {
    try {
        const id   = req.reseller.id; // FIX BUG-001: was req.user.id
        const period = parseInt(req.query.period, 10) || 30;
        const days   = Math.min(Math.max(period, 7), 90); // clamp 7–90

        // FIX BUG-002: was string-interpolated into SQL; now a safe parameterised value.
        // SQLite datetime('now', ?) accepts modifier strings like '-30 days'.
        const intervalParam = `-${days} days`;

        const [rows] = await db.query(`
            SELECT
                date(paid_at)               AS day,
                COALESCE(SUM(total_usd), 0) AS revenue,
                COUNT(*)                    AS count
            FROM payments
            WHERE reseller_id = ? AND status = 'paid'
              AND paid_at >= datetime('now', ?)
            GROUP BY date(paid_at)
            ORDER BY day ASC
        `, [id, intervalParam]);

        // Fill missing days with zeros so the chart always has a complete series
        const dataMap = {};
        rows.forEach(r => {
            dataMap[r.day] = { revenue: parseFloat(r.revenue), count: r.count };
        });

        const labels   = [];
        const revenues = [];
        const counts   = [];

        for (let i = days - 1; i >= 0; i--) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            const key = d.toISOString().split('T')[0];
            labels.push(key);
            revenues.push(dataMap[key]?.revenue || 0);
            counts.push(dataMap[key]?.count   || 0);
        }

        res.json({ labels, revenues, counts });
    } catch (err) {
        console.error('Analytics chart error:', err);
        res.status(500).json({ error: 'Failed to load chart data' });
    }
});

// ─── GET /api/analytics/top-links ────────────────────────────────────────────
router.get('/api/analytics/top-links', auth, async (req, res) => {
    try {
        // FIX BUG-001: was req.user.id
        const [rows] = await db.query(`
            SELECT
                pl.title,
                pl.slug,
                COUNT(p.id)                   AS payment_count,
                COALESCE(SUM(p.total_usd), 0) AS total_revenue,
                MAX(p.paid_at)                AS last_payment
            FROM payment_links pl
            LEFT JOIN payments p ON p.link_id = pl.id AND p.status = 'paid'
            WHERE pl.reseller_id = ?
            GROUP BY pl.id
            ORDER BY total_revenue DESC
            LIMIT 10
        `, [req.reseller.id]);

        res.json(rows.map(r => ({
            ...r,
            total_revenue: parseFloat(r.total_revenue).toFixed(2)
        })));
    } catch (err) {
        console.error('Top links error:', err);
        res.status(500).json({ error: 'Failed to load top links' });
    }
});

// ─── GET /api/analytics/recent ───────────────────────────────────────────────
router.get('/api/analytics/recent', auth, async (req, res) => {
    try {
        // FIX BUG-001: was req.user.id
        const [rows] = await db.query(`
            SELECT p.id, p.total_usd, p.status, p.paid_at, p.created_at, p.payer_ip,
                   pl.title AS link_title, pl.slug
            FROM payments p
            LEFT JOIN payment_links pl ON pl.id = p.link_id
            WHERE p.reseller_id = ? AND p.status = 'paid'
            ORDER BY p.paid_at DESC
            LIMIT 10
        `, [req.reseller.id]);

        res.json(rows);
    } catch (err) {
        console.error('Recent payments error:', err);
        res.status(500).json({ error: 'Failed to load recent payments' });
    }
});

module.exports = router;
