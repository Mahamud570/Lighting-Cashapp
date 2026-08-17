const express = require('express');
const router = express.Router();
const db = require('../database/db');
const auth = require('../middleware/auth');
const { createObjectCsvWriter } = require('csv-writer');
const path = require('path');
const fs = require('fs');
const os = require('os'); // for safe temp dir (S-007 fix)

// GET /api/payments
router.get('/api/payments', auth, async (req, res) => {
    try {
        const { status, from, to, page = 1, limit = 50 } = req.query;
        // Cap limit at 500 to prevent OOM attacks (was uncapped — user could request limit=100000)
        const safeLimit  = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500);
        const safePage   = Math.max(parseInt(page, 10) || 1, 1);
        const offset     = (safePage - 1) * safeLimit;

        let where = 'p.reseller_id = ?';
        const params = [req.reseller.id];

        if (status && status !== 'all') { where += ' AND p.status = ?'; params.push(status); }
        if (from) { where += ' AND date(p.created_at) >= date(?)'; params.push(from); }
        if (to) { where += ' AND date(p.created_at) <= date(?)'; params.push(to); }

        const [payments] = await db.query(
            `SELECT p.*, pl.slug, pl.title FROM payments p
             LEFT JOIN payment_links pl ON p.link_id = pl.id
             WHERE ${where} ORDER BY p.created_at DESC LIMIT ? OFFSET ?`,
            [...params, safeLimit, offset]
        );

        const [[{ total }]] = await db.query(
            `SELECT COUNT(*) as total FROM payments p WHERE ${where}`,
            params
        );

        res.json({ payments, total, page: safePage, limit: safeLimit });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/payments/export - CSV
router.get('/api/payments/export', auth, async (req, res) => {
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
             WHERE ${where} ORDER BY p.created_at DESC`,
            params
        );

        // S-007 FIX: Write temp CSV to OS temp dir, NOT to public/uploads/ which is
        // publicly accessible via HTTP (even briefly during the download).
        const tmpFile = path.join(os.tmpdir(), `payments_export_${Date.now()}.csv`);
        const csvWriter = createObjectCsvWriter({
            path: tmpFile,
            header: [
                { id: 'created_at',       title: 'Date' },
                { id: 'slug',             title: 'Link' },
                { id: 'payer_ip',         title: 'Payer IP' },
                { id: 'amount_usd',       title: 'Amount USD' },
                { id: 'charge_usd',       title: 'Charge USD' },
                { id: 'total_usd',        title: 'Total USD' },
                { id: 'receiving_wallet', title: 'Wallet' },
                { id: 'status',           title: 'Status' },
                { id: 'paid_at',          title: 'Paid At' }
            ]
        });

        await csvWriter.writeRecords(payments);

        // M-004 FIX: Use try/finally so file is always cleaned up, even if download errors
        res.download(tmpFile, 'payments.csv', (err) => {
            // Delete temp file regardless of download success or failure
            try { fs.unlinkSync(tmpFile); } catch (_) {}
            if (err) console.error('[payments] CSV download error:', err.message);
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PATCH /api/payments/:id/check - seller check
router.patch('/api/payments/:id/check', auth, async (req, res) => {
    try {
        await db.query(
            'UPDATE payments SET seller_checked = 1 WHERE id = ? AND reseller_id = ?',
            [req.params.id, req.reseller.id]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/activities
router.get('/api/activities', auth, async (req, res) => {
    try {
        const { event, actor, from, to } = req.query;
        let where = 'reseller_id = ?';
        const params = [req.reseller.id];

        if (event && event !== 'all') { where += ' AND event = ?'; params.push(event); }
        if (actor && actor !== 'all') { where += ' AND actor = ?'; params.push(actor); }
        if (from) { where += ' AND date(created_at) >= ?'; params.push(from); }
        if (to) { where += ' AND date(created_at) <= ?'; params.push(to); }

        const [activities] = await db.query(
            `SELECT * FROM activities WHERE ${where} ORDER BY created_at DESC LIMIT 100`,
            params
        );

        res.json(activities);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/transaction-charge
router.get('/api/transaction-charge', auth, async (req, res) => {
    res.json({
        charge_mode: req.reseller.charge_mode,
        charge_value: req.reseller.charge_value
    });
});

// POST /api/transaction-charge
router.post('/api/transaction-charge', auth, async (req, res) => {
    try {
        const { charge_mode, charge_value } = req.body;
        if (!['none', 'fixed', 'percent'].includes(charge_mode)) {
            return res.status(400).json({ error: 'Invalid charge mode' });
        }
        await db.query(
            'UPDATE resellers SET charge_mode = ?, charge_value = ? WHERE id = ?',
            [charge_mode, parseFloat(charge_value) || 0, req.reseller.id]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
