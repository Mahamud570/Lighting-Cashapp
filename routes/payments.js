const express = require('express');
const router = express.Router();
const db = require('../database/db');
const auth = require('../middleware/auth');
const { requireRole } = auth;
const { createObjectCsvWriter } = require('csv-writer');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Sub-users may view only their own payments.
router.get('/api/payments', auth, async (req, res) => {
    try {
        const { status, from, to, page = 1, limit = 50 } = req.query;
        const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500);
        const safePage = Math.max(parseInt(page, 10) || 1, 1);
        const offset = (safePage - 1) * safeLimit;
        const isSubUser = req.role === 'sub_user';
        let where = 'p.reseller_id = ?';
        const params = [req.reseller.id];
        if (isSubUser) { where += ' AND p.sub_user_id = ?'; params.push(req.sub_user.id); }
        if (status && status !== 'all') { where += ' AND p.status = ?'; params.push(status); }
        if (from) { where += ' AND date(p.created_at) >= date(?)'; params.push(from); }
        if (to) { where += ' AND date(p.created_at) <= date(?)'; params.push(to); }

        const [payments] = await db.query(
            `SELECT p.*, pl.slug, pl.title FROM payments p
             LEFT JOIN payment_links pl ON p.link_id = pl.id
             WHERE ${where} ORDER BY p.created_at DESC LIMIT ? OFFSET ?`,
            [...params, safeLimit, offset]
        );
        const [[{ total }]] = await db.query(`SELECT COUNT(*) as total FROM payments p WHERE ${where}`, params);
        res.json({ payments, total, page: safePage, limit: safeLimit });
    } catch (err) { res.status(500).json({ error: 'Failed to load payments' }); }
});

// CSV export contains sensitive payer/payment fields and is reseller/owner only.
router.get('/api/payments/export', auth, requireRole('reseller', 'owner'), async (req, res) => {
    try {
        const { status, from, to } = req.query;
        let where = 'p.reseller_id = ?';
        const params = [req.reseller.id];
        if (status && status !== 'all') { where += ' AND p.status = ?'; params.push(status); }
        if (from) { where += ' AND DATE(p.created_at) >= ?'; params.push(from); }
        if (to) { where += ' AND DATE(p.created_at) <= ?'; params.push(to); }

        const [payments] = await db.query(
            `SELECT p.created_at, pl.slug, p.payer_ip, p.amount_usd, p.charge_usd, p.total_usd, p.receiving_wallet, p.status, p.paid_at
             FROM payments p LEFT JOIN payment_links pl ON p.link_id = pl.id
             WHERE ${where} ORDER BY p.created_at DESC`, params
        );

        const tmpFile = path.join(os.tmpdir(), `payments_export_${Date.now()}.csv`);
        const csvWriter = createObjectCsvWriter({ path: tmpFile, header: [
            { id: 'created_at', title: 'Date' }, { id: 'slug', title: 'Link' }, { id: 'payer_ip', title: 'Payer IP' },
            { id: 'amount_usd', title: 'Amount USD' }, { id: 'charge_usd', title: 'Charge USD' }, { id: 'total_usd', title: 'Total USD' },
            { id: 'receiving_wallet', title: 'Wallet' }, { id: 'status', title: 'Status' }, { id: 'paid_at', title: 'Paid At' }
        ]});
        await csvWriter.writeRecords(payments);
        res.download(tmpFile, 'payments.csv', err => { try { fs.unlinkSync(tmpFile); } catch (_) {} if (err) console.error('[payments] CSV download error:', err.message); });
    } catch (err) { res.status(500).json({ error: 'Failed to export payments' }); }
});

// Seller-check is a reseller/owner operation, not a sub-user capability.
router.patch('/api/payments/:id/check', auth, requireRole('reseller', 'owner'), async (req, res) => {
    try {
        const [result] = await db.query('UPDATE payments SET seller_checked = 1 WHERE id = ? AND reseller_id = ?', [req.params.id, req.reseller.id]);
        if (!result.affectedRows) return res.status(404).json({ error: 'Payment not found' });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Failed to update payment' }); }
});

// Activity/audit timeline is reseller/owner only.
router.get('/api/activities', auth, requireRole('reseller', 'owner'), async (req, res) => {
    try {
        const { event, actor, from, to } = req.query;
        let where = 'reseller_id = ?';
        const params = [req.reseller.id];
        if (event && event !== 'all') { where += ' AND event = ?'; params.push(event); }
        if (actor && actor !== 'all') { where += ' AND actor = ?'; params.push(actor); }
        if (from) { where += ' AND date(created_at) >= ?'; params.push(from); }
        if (to) { where += ' AND date(created_at) <= ?'; params.push(to); }
        const [activities] = await db.query(`SELECT * FROM activities WHERE ${where} ORDER BY created_at DESC LIMIT 100`, params);
        res.json(activities);
    } catch (err) { res.status(500).json({ error: 'Failed to load activities' }); }
});

router.get('/api/transaction-charge', auth, requireRole('reseller', 'owner'), async (req, res) => {
    res.json({ charge_mode: req.reseller.charge_mode, charge_value: req.reseller.charge_value });
});

router.post('/api/transaction-charge', auth, requireRole('reseller', 'owner'), async (req, res) => {
    try {
        const { charge_mode, charge_value } = req.body;
        if (!['none', 'fixed', 'percent'].includes(charge_mode)) return res.status(400).json({ error: 'Invalid charge mode' });
        await db.query('UPDATE resellers SET charge_mode = ?, charge_value = ? WHERE id = ?', [charge_mode, parseFloat(charge_value) || 0, req.reseller.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Failed to save transaction charge' }); }
});

module.exports = router;
