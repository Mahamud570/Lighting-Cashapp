const express = require('express');
const router = express.Router();
const db = require('../database/db');
const auth = require('../middleware/auth');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// File upload config
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = './public/uploads/logos';
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        cb(null, `logo_${req.reseller.id}_${Date.now()}${ext}`);
    }
});
const upload = multer({ storage, limits: { fileSize: 2 * 1024 * 1024 } });

// GET /api/links - list all payment links
router.get('/api/links', auth, async (req, res) => {
    try {
        const [links] = await db.query(
            `SELECT pl.*, 
             (SELECT COUNT(*) FROM payments p WHERE p.link_id = pl.id) as invoice_count,
             COALESCE(su.name, 'Reseller') as owner_name
             FROM payment_links pl
             LEFT JOIN sub_users su ON pl.sub_user_id = su.id
             WHERE pl.reseller_id = ?
             ORDER BY pl.created_at DESC`,
            [req.reseller.id]
        );
        res.json(links);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/links - create payment link
router.post('/api/links', auth, upload.single('logo'), async (req, res) => {
    try {
        const { slug, title, brand_name, domain, theme, amount_type, fixed_amount, min_amount, max_amount, sub_user_id } = req.body;

        if (!slug || !title) return res.status(400).json({ error: 'Slug and title are required' });

        // Check slug uniqueness
        const [existing] = await db.query('SELECT id FROM payment_links WHERE slug = ?', [slug]);
        if (existing.length) return res.status(400).json({ error: 'This payment link URL is already taken' });

        const logoPath = req.file ? `/uploads/logos/${req.file.filename}` : null;

        await db.query(
            `INSERT INTO payment_links (reseller_id, sub_user_id, slug, title, brand_name, logo_path, domain, theme, amount_type, fixed_amount, min_amount, max_amount)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
            [
                req.reseller.id,
                sub_user_id || null,
                slug.toLowerCase().replace(/[^a-z0-9-_]/g, ''),
                title,
                brand_name || 'Cash Pay',
                logoPath,
                domain || 'localhost:3000',
                theme || 'default',
                amount_type || 'open',
                fixed_amount || null,
                min_amount || 1,
                max_amount || 2000
            ]
        );

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PATCH /api/links/:id/status - toggle status
router.patch('/api/links/:id/status', auth, async (req, res) => {
    try {
        const [link] = await db.query('SELECT * FROM payment_links WHERE id = ? AND reseller_id = ?', [req.params.id, req.reseller.id]);
        if (!link.length) return res.status(404).json({ error: 'Link not found' });

        const newStatus = link[0].status === 'active' ? 'inactive' : 'active';
        await db.query('UPDATE payment_links SET status = ? WHERE id = ?', [newStatus, req.params.id]);
        res.json({ success: true, status: newStatus });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/links/:id
router.delete('/api/links/:id', auth, async (req, res) => {
    try {
        await db.query('DELETE FROM payment_links WHERE id = ? AND reseller_id = ?', [req.params.id, req.reseller.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/themes - list themes
router.get('/api/themes', auth, async (req, res) => {
    try {
        const [themes] = await db.query(
            'SELECT * FROM payment_themes WHERE is_global = 1 OR reseller_id = ? ORDER BY is_global DESC, id ASC',
            [req.reseller.id]
        );
        res.json(themes);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
