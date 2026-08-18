const express = require('express');
const router = express.Router();
const db = require('../database/db');
const auth = require('../middleware/auth');
const { requireRole } = auth;
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const ALLOWED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

function validateImageMagicBytes(filePath) {
    try {
        if (!fs.existsSync(filePath)) return false;
        const buffer = Buffer.alloc(12);
        const fd = fs.openSync(filePath, 'r');
        fs.readSync(fd, buffer, 0, 12, 0);
        fs.closeSync(fd);
        if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) return true;
        if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) return true;
        if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) return true;
        if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 && buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) return true;
        return false;
    } catch (_) {
        return false;
    }
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = './public/uploads/logos';
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        if (!ALLOWED_EXTENSIONS.has(ext)) return cb(new Error('Invalid image file extension'));
        cb(null, `logo_${crypto.randomBytes(16).toString('hex')}${ext}`);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 2 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        if (ALLOWED_IMAGE_TYPES.has(file.mimetype) && ALLOWED_EXTENSIONS.has(ext)) cb(null, true);
        else cb(new Error('Only image files are allowed (jpg, png, gif, webp)'), false);
    }
});

const RESERVED_SLUGS = new Set([
    'api', 'admin', 'login', 'register', 'logout', 'reseller', 'pay',
    'dashboard', 'webhook', 'webhooks', 'static', 'uploads', 'health', 'status', 'metrics'
]);

// Sub-users may only READ their own assigned links.
router.get('/api/links', auth, async (req, res) => {
    try {
        const isSubUser = req.role === 'sub_user';
        let query = `
            SELECT pl.*, su.name as sub_user_name,
                   (SELECT COUNT(*) FROM payments p WHERE p.link_id = pl.id AND p.status = 'paid') as payment_count,
                   COALESCE((SELECT SUM(total_usd) FROM payments p WHERE p.link_id = pl.id AND p.status = 'paid'), 0) as total_volume_usd
            FROM payment_links pl
            LEFT JOIN sub_users su ON pl.sub_user_id = su.id
            WHERE pl.reseller_id = ?`;
        const params = [req.reseller.id];
        if (isSubUser) {
            query += ' AND pl.sub_user_id = ?';
            params.push(req.sub_user.id);
        }
        query += ' ORDER BY pl.created_at DESC';
        const [links] = await db.query(query, params);
        res.json(links);
    } catch (err) {
        res.status(500).json({ error: 'Failed to load payment links' });
    }
});

// Sub-users cannot create payment links.
router.post('/api/links', auth, requireRole('reseller', 'owner'), upload.single('logo'), async (req, res) => {
    try {
        const { slug, title, brand_name, domain, theme, amount_type, fixed_amount, min_amount, max_amount, sub_user_id } = req.body;
        if (!slug || !title) return res.status(400).json({ error: 'Slug and title are required' });

        const cleanSlug = slug.toLowerCase().replace(/[^a-z0-9-_]/g, '');
        if (RESERVED_SLUGS.has(cleanSlug)) return res.status(400).json({ error: `'${cleanSlug}' is a reserved name and cannot be used as a slug` });

        const [existing] = await db.query('SELECT id FROM payment_links WHERE slug = ?', [cleanSlug]);
        if (existing.length) return res.status(400).json({ error: 'This payment link URL is already taken' });

        if (req.file) {
            const valid = validateImageMagicBytes(req.file.path);
            if (!valid) {
                try { fs.unlinkSync(req.file.path); } catch (_) {}
                return res.status(400).json({ error: 'Uploaded file is not a valid image.' });
            }
        }

        const logoPath = req.file ? `/uploads/logos/${req.file.filename}` : null;
        let linkSubUserId = null;
        if (sub_user_id && sub_user_id !== 'null' && sub_user_id !== '') {
            const targetId = parseInt(sub_user_id, 10);
            if (req.role !== 'owner') {
                const [validSub] = await db.query('SELECT id FROM sub_users WHERE id = ? AND reseller_id = ?', [targetId, req.reseller.id]);
                if (!validSub.length) return res.status(403).json({ error: 'Unauthorized: Sub-user does not belong to your account' });
            }
            linkSubUserId = targetId;
        }

        await db.query(
            `INSERT INTO payment_links (reseller_id, sub_user_id, slug, title, brand_name, logo_path, domain, theme, amount_type, fixed_amount, min_amount, max_amount)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
            [req.reseller.id, linkSubUserId, cleanSlug, String(title).substring(0, 100), String(brand_name || 'Cash Pay').substring(0, 60), logoPath, domain || req.get('host') || 'portal-cash-app.com', theme || 'default', amount_type || 'open', fixed_amount || null, min_amount || 1, max_amount || 2000]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to create payment link' });
    }
});

// Only reseller/owner can activate/deactivate links.
router.patch('/api/links/:id/status', auth, requireRole('reseller', 'owner'), async (req, res) => {
    try {
        const [link] = await db.query('SELECT * FROM payment_links WHERE id = ? AND reseller_id = ?', [req.params.id, req.reseller.id]);
        if (!link.length) return res.status(404).json({ error: 'Link not found' });
        const newStatus = link[0].status === 'active' ? 'inactive' : 'active';
        await db.query('UPDATE payment_links SET status = ? WHERE id = ?', [newStatus, req.params.id]);
        res.json({ success: true, status: newStatus });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update link status' });
    }
});

// Only reseller/owner can delete links.
router.delete('/api/links/:id', auth, requireRole('reseller', 'owner'), async (req, res) => {
    try {
        const [result] = await db.query('DELETE FROM payment_links WHERE id = ? AND reseller_id = ?', [req.params.id, req.reseller.id]);
        if (!result.affectedRows) return res.status(404).json({ error: 'Payment link not found' });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete payment link' });
    }
});

// Only reseller/owner can assign/reassign links.
router.put('/api/links/:id/assign', auth, requireRole('reseller', 'owner'), async (req, res) => {
    try {
        const { sub_user_id } = req.body;
        const targetId = (sub_user_id && sub_user_id !== 'null' && sub_user_id !== '') ? parseInt(sub_user_id, 10) : null;

        if (targetId && req.role !== 'owner') {
            const [validSub] = await db.query('SELECT id FROM sub_users WHERE id = ? AND reseller_id = ?', [targetId, req.reseller.id]);
            if (!validSub.length) return res.status(403).json({ error: 'Unauthorized: Sub-user does not belong to your account' });
        }

        const [result] = await db.query(
            'UPDATE payment_links SET sub_user_id = ? WHERE id = ? AND (reseller_id = ? OR ? = "owner")',
            [targetId, req.params.id, req.reseller.id, req.role || 'reseller']
        );
        if (!result.affectedRows) return res.status(404).json({ error: 'Payment link not found' });
        res.json({ success: true, message: 'Link assigned successfully' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to assign payment link' });
    }
});

router.get('/api/themes', auth, requireRole('reseller', 'owner'), async (req, res) => {
    try {
        const [themes] = await db.query('SELECT * FROM payment_themes WHERE is_global = 1 OR reseller_id = ? ORDER BY is_global DESC, id ASC', [req.reseller.id]);
        res.json(themes);
    } catch (err) {
        res.status(500).json({ error: 'Failed to load themes' });
    }
});

module.exports = router;
