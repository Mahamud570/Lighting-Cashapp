const express = require('express');
const router = express.Router();
const db = require('../database/db');
const auth = require('../middleware/auth');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// File upload config — images only (S-005 fix: accept only image MIME types)
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = './public/uploads/logos';
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        cb(null, `logo_${req.reseller.id}_${Date.now()}${ext}`);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 2 * 1024 * 1024 }, // 2 MB
    fileFilter: (req, file, cb) => {
        if (ALLOWED_IMAGE_TYPES.has(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Only image files are allowed (jpg, png, gif, webp)'), false);
        }
    }
});

// Slugs that would collide with existing API/page routes
const RESERVED_SLUGS = new Set([
    'api', 'admin', 'login', 'register', 'logout', 'reseller',
    'pay', 'dashboard', 'webhook', 'webhooks', 'static', 'uploads',
    'health', 'status', 'metrics'
]);

// GET /api/links - list all payment links
router.get('/api/links', auth, async (req, res) => {
    try {
        const isSubUser = req.role === 'sub_user';
        let where = 'pl.reseller_id = ?';
        const params = [req.reseller.id];
        if (isSubUser) {
            where += ' AND pl.sub_user_id = ?';
            params.push(req.sub_user.id);
        }

        const [links] = await db.query(
            `SELECT pl.*, 
             (SELECT COUNT(*) FROM payments p WHERE p.link_id = pl.id) as invoice_count,
             COALESCE(su.name, 'Reseller') as owner_name
             FROM payment_links pl
             LEFT JOIN sub_users su ON pl.sub_user_id = su.id
             WHERE ${where}
             ORDER BY pl.created_at DESC`,
            params
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

        const cleanSlug = slug.toLowerCase().replace(/[^a-z0-9-_]/g, '');

        // Prevent squatting reserved route namespaces
        if (RESERVED_SLUGS.has(cleanSlug)) {
            return res.status(400).json({ error: `'${cleanSlug}' is a reserved name and cannot be used as a slug` });
        }

        // Check slug uniqueness
        const [existing] = await db.query('SELECT id FROM payment_links WHERE slug = ?', [cleanSlug]);
        if (existing.length) return res.status(400).json({ error: 'This payment link URL is already taken' });

        const logoPath = req.file ? `/uploads/logos/${req.file.filename}` : null;
        const isSubUser = req.role === 'sub_user';
        let linkSubUserId = null;
        if (isSubUser) {
            linkSubUserId = req.sub_user.id;
        } else if (sub_user_id && sub_user_id !== 'null' && sub_user_id !== '') {
            const targetId = parseInt(sub_user_id, 10);
            if (req.role !== 'owner') {
                const [validSub] = await db.query('SELECT id FROM sub_users WHERE id = ? AND reseller_id = ?', [targetId, req.reseller.id]);
                if (!validSub.length) {
                    return res.status(403).json({ error: 'Unauthorized: Sub-user does not belong to your account' });
                }
            }
            linkSubUserId = targetId;
        }

        await db.query(
            `INSERT INTO payment_links (reseller_id, sub_user_id, slug, title, brand_name, logo_path, domain, theme, amount_type, fixed_amount, min_amount, max_amount)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
            [
                req.reseller.id,
                linkSubUserId,
                cleanSlug,
                String(title).substring(0, 100),                      // max 100 chars
                String(brand_name || 'Cash Pay').substring(0, 60),    // max 60 chars
                logoPath,
                domain || req.get('host') || 'portal-cash-app.com',
                theme || 'default',
                amount_type || 'open',
                fixed_amount || null,
                min_amount   || 1,
                max_amount   || 2000
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
        const isSubUser = req.role === 'sub_user';
        let query = 'SELECT * FROM payment_links WHERE id = ? AND reseller_id = ?';
        const params = [req.params.id, req.reseller.id];
        if (isSubUser) {
            query += ' AND sub_user_id = ?';
            params.push(req.sub_user.id);
        }

        const [link] = await db.query(query, params);
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
        const isSubUser = req.role === 'sub_user';
        let query = 'DELETE FROM payment_links WHERE id = ? AND reseller_id = ?';
        const params = [req.params.id, req.reseller.id];
        if (isSubUser) {
            query += ' AND sub_user_id = ?';
            params.push(req.sub_user.id);
        }

        const [result] = await db.query(query, params);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/links/:id/assign - assign or reassign link to a sub-user / merchant
router.put('/api/links/:id/assign', auth, async (req, res) => {
    try {
        const { sub_user_id } = req.body;
        const targetId = (sub_user_id && sub_user_id !== 'null' && sub_user_id !== '') ? parseInt(sub_user_id, 10) : null;

        if (targetId && req.role !== 'owner') {
            const [validSub] = await db.query('SELECT id FROM sub_users WHERE id = ? AND reseller_id = ?', [targetId, req.reseller.id]);
            if (!validSub.length) {
                return res.status(403).json({ error: 'Unauthorized: Sub-user does not belong to your account' });
            }
        }

        const [result] = await db.query(
            'UPDATE payment_links SET sub_user_id = ? WHERE id = ? AND (reseller_id = ? OR ? = "owner")',
            [targetId, req.params.id, req.reseller.id, req.role || 'reseller']
        );
        if (!result.affectedRows) {
            return res.status(404).json({ error: 'Payment link not found' });
        }
        res.json({ success: true, message: 'Link assigned successfully' });
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
