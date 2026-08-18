const express = require('express');
const router = express.Router();
const db = require('../database/db');
const auth = require('../middleware/auth');
const { requireRole } = auth;

router.use('/api/subuser', auth, requireRole('sub_user'));

function roundMoney(value) {
    return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

async function getBalance(subUserId) {
    const [[earned]] = await db.query(
        `SELECT COALESCE(SUM(total_usd), 0) AS total_received
         FROM payments
         WHERE sub_user_id = ? AND status = 'paid'`,
        [subUserId]
    );

    const [[withdrawn]] = await db.query(
        `SELECT COALESCE(SUM(amount_usd), 0) AS reserved_amount
         FROM withdrawals
         WHERE sub_user_id = ? AND status IN ('pending', 'approved')`,
        [subUserId]
    );

    const totalReceived = Number(earned?.total_received || 0);
    const reserved = Number(withdrawn?.reserved_amount || 0);
    return Math.max(0, roundMoney(totalReceived - reserved));
}

// GET /api/subuser/overview
router.get('/api/subuser/overview', async (req, res) => {
    try {
        const su = req.sub_user;
        const availableBalance = await getBalance(su.id);
        const rate = Number(su.rate_per_dollar || 1);
        const estimatedPayout = roundMoney(availableBalance * rate);

        const [[totals]] = await db.query(
            `SELECT
                COUNT(*) AS total_invoices,
                COUNT(CASE WHEN status = 'paid' THEN 1 END) AS paid_invoices,
                COUNT(CASE WHEN status = 'pending' THEN 1 END) AS pending_invoices,
                COUNT(CASE WHEN status = 'expired' THEN 1 END) AS expired_invoices,
                COALESCE(SUM(CASE WHEN status = 'paid' THEN total_usd ELSE 0 END), 0) AS total_received
             FROM payments WHERE sub_user_id = ?`,
            [su.id]
        );

        const [[clicks]] = await db.query(
            `SELECT COALESCE(SUM(clicks), 0) AS total_clicks
             FROM payment_links WHERE sub_user_id = ?`,
            [su.id]
        );

        const conversion = Number(totals.total_invoices || 0) > 0
            ? Number(((Number(totals.paid_invoices || 0) / Number(totals.total_invoices)) * 100).toFixed(1))
            : 0;

        res.json({
            name: su.name,
            email: su.email,
            total_received: roundMoney(totals.total_received),
            available_balance: availableBalance,
            rate_per_dollar: rate,
            estimated_payout: estimatedPayout,
            total_clicks: Number(clicks.total_clicks || 0),
            total_invoices: Number(totals.total_invoices || 0),
            paid_invoices: Number(totals.paid_invoices || 0),
            pending_invoices: Number(totals.pending_invoices || 0),
            expired_invoices: Number(totals.expired_invoices || 0),
            conversion_rate: conversion
        });
    } catch (err) {
        console.error('[subuser] Overview error:', err);
        res.status(500).json({ error: 'Failed to load sub-user overview' });
    }
});

// GET /api/subuser/links
router.get('/api/subuser/links', async (req, res) => {
    try {
        const [links] = await db.query(
            `SELECT
                pl.id, pl.slug, pl.title, pl.fixed_amount, pl.amount_type,
                pl.min_amount, pl.max_amount, pl.status, pl.is_scan_code,
                pl.clicks, pl.created_at,
                (SELECT COUNT(*) FROM payments p WHERE p.link_id = pl.id) AS invoice_count,
                (SELECT COUNT(*) FROM payments p WHERE p.link_id = pl.id AND p.status = 'paid') AS paid_count,
                (SELECT COALESCE(SUM(p.total_usd), 0) FROM payments p WHERE p.link_id = pl.id AND p.status = 'paid') AS paid_volume
             FROM payment_links pl
             WHERE pl.sub_user_id = ? AND pl.reseller_id = ?
             ORDER BY pl.created_at DESC`,
            [req.sub_user.id, req.sub_user.reseller_id]
        );

        res.json(links.map(link => ({
            ...link,
            paid_volume: roundMoney(link.paid_volume)
        })));
    } catch (err) {
        console.error('[subuser] Links error:', err);
        res.status(500).json({ error: 'Failed to load assigned payment links' });
    }
});

// GET /api/subuser/analytics
router.get('/api/subuser/analytics', async (req, res) => {
    try {
        const subUserId = req.sub_user.id;

        const [links] = await db.query(
            `SELECT
                pl.id, pl.title, pl.slug, pl.clicks,
                COUNT(p.id) AS invoice_count,
                COUNT(CASE WHEN p.status = 'paid' THEN 1 END) AS paid_count,
                COALESCE(SUM(CASE WHEN p.status = 'paid' THEN p.total_usd ELSE 0 END), 0) AS paid_volume
             FROM payment_links pl
             LEFT JOIN payments p ON p.link_id = pl.id
             WHERE pl.sub_user_id = ? AND pl.reseller_id = ?
             GROUP BY pl.id
             ORDER BY paid_volume DESC, pl.clicks DESC`,
            [subUserId, req.sub_user.reseller_id]
        );

        const [recent] = await db.query(
            `SELECT p.id, p.status, p.amount_usd, p.charge_usd, p.total_usd,
                    p.created_at, p.paid_at, pl.slug, pl.title
             FROM payments p
             LEFT JOIN payment_links pl ON pl.id = p.link_id
             WHERE p.sub_user_id = ? AND p.reseller_id = ?
             ORDER BY p.created_at DESC LIMIT 25`,
            [subUserId, req.sub_user.reseller_id]
        );

        res.json({
            links: links.map(l => ({ ...l, paid_volume: roundMoney(l.paid_volume) })),
            recent_payments: recent
        });
    } catch (err) {
        console.error('[subuser] Analytics error:', err);
        res.status(500).json({ error: 'Failed to load sub-user analytics' });
    }
});

// GET /api/subuser/withdrawals
router.get('/api/subuser/withdrawals', async (req, res) => {
    try {
        const [rows] = await db.query(
            `SELECT id, amount_usd, rate, payout_amount, status, note, created_at
             FROM withdrawals
             WHERE sub_user_id = ? AND reseller_id = ?
             ORDER BY created_at DESC LIMIT 50`,
            [req.sub_user.id, req.sub_user.reseller_id]
        );
        res.json(rows);
    } catch (err) {
        console.error('[subuser] Withdrawals error:', err);
        res.status(500).json({ error: 'Failed to load withdrawal history' });
    }
});

// POST /api/subuser/withdrawals
router.post('/api/subuser/withdrawals', async (req, res) => {
    try {
        const requested = Number(req.body?.amount_usd);
        if (!Number.isFinite(requested) || requested <= 0) {
            return res.status(400).json({ error: 'Enter a valid withdrawal amount' });
        }

        const availableBalance = await getBalance(req.sub_user.id);
        if (requested > availableBalance + 0.000001) {
            return res.status(400).json({ error: `Insufficient available balance. Maximum: $${availableBalance.toFixed(2)}` });
        }

        const rate = Number(req.sub_user.rate_per_dollar || 1);
        const payoutAmount = roundMoney(requested * rate);
        if (payoutAmount <= 0) {
            return res.status(400).json({ error: 'Calculated payout amount must be greater than zero' });
        }

        await db.query(
            `INSERT INTO withdrawals (reseller_id, sub_user_id, amount_usd, rate, payout_amount, status)
             VALUES (?, ?, ?, ?, ?, 'pending')`,
            [req.sub_user.reseller_id, req.sub_user.id, roundMoney(requested), rate, payoutAmount]
        );

        res.json({ success: true, amount_usd: roundMoney(requested), rate, payout_amount: payoutAmount, status: 'pending' });
    } catch (err) {
        console.error('[subuser] Withdrawal request error:', err);
        res.status(500).json({ error: 'Failed to submit withdrawal request' });
    }
});

module.exports = router;
