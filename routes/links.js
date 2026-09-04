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

function rejectLink(req, res, status, error) {
    if (req.file?.path) try { fs.unlinkSync(req.file.path); } catch (_) {}
    return res.status(status).json({ error });
}

function validateCharge(modeInput, valueInput) {
    const mode = String(modeInput || 'inherit').toLowerCase();
    if (!['inherit', 'none', 'fixed', 'percent'].includes(mode)) return { error: 'Invalid fee mode' };
    const value = mode === 'inherit' || mode === 'none' ? 0 : Number(valueInput);
    if (!Number.isFinite(value) || value < 0) return { error: 'Enter a valid fee value' };
    if (mode === 'fixed' && value > 100) return { error: 'Fixed fee cannot exceed $100' };
    if (mode === 'percent' && value > 50) return { error: 'Percentage fee cannot exceed 50%' };
    return { mode, value };
}

function normalizeDomain(value, fallback = '') {
    return String(value || fallback || '')
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, '')
        .replace(/\/.*$/, '')
        .replace(/^www\./, '')
        .substring(0, 253);
}

// Sub-users may only READ their own assigned links.
router.get('/api/links', auth, async (req, res) => {
    try {
        const isSubUser = req.role === 'sub_user';
        let query = `
            SELECT pl.*, su.name as sub_user_name, COALESCE(su.name, 'Reseller') as owner_name,
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
        const { slug, title, brand_name, domain, theme, amount_type, fixed_amount, min_amount, max_amount, sub_user_id, charge_mode, charge_value, preview_mode } = req.body;
        if (!slug || !title) return rejectLink(req, res, 400, 'Slug and title are required');

        const cleanSlug = slug.toLowerCase().replace(/[^a-z0-9-_]/g, '');
        const cleanTitle = String(title).trim();
        const cleanBrand = String(brand_name || 'Cash Pay').trim();
        const cleanTheme = String(theme || 'default').toLowerCase();
        const amountType = amount_type || 'open';
        const previewMode = String(preview_mode || 'full').toLowerCase();
        const fixed = Number(fixed_amount);
        const min = min_amount === '' || min_amount == null ? 1 : Number(min_amount);
        const max = max_amount === '' || max_amount == null ? 2000 : Number(max_amount);
        if (cleanSlug.length < 3 || cleanSlug.length > 80) return rejectLink(req, res, 400, 'Slug must be 3–80 characters');
        if (!cleanTitle || cleanTitle.length > 100) return rejectLink(req, res, 400, 'Title must be 1–100 characters');
        if (!cleanBrand || cleanBrand.length > 60) return rejectLink(req, res, 400, 'Brand name must be 1–60 characters');
        if (!/^[a-z0-9_-]{1,30}$/.test(cleanTheme)) return rejectLink(req, res, 400, 'Invalid theme');
        if (!['open', 'fixed'].includes(amountType)) return rejectLink(req, res, 400, 'Invalid amount type');
        if (!['full', 'imessage_compact'].includes(previewMode)) return rejectLink(req, res, 400, 'Invalid preview mode');
        if (amountType === 'fixed' && (!Number.isFinite(fixed) || fixed <= 0 || fixed > 1000000)) return rejectLink(req, res, 400, 'Enter a valid fixed amount');
        if (amountType === 'open' && (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max < min || max > 1000000)) return rejectLink(req, res, 400, 'Enter a valid minimum and maximum amount');
        if (RESERVED_SLUGS.has(cleanSlug)) return rejectLink(req, res, 400, `'${cleanSlug}' is a reserved name and cannot be used as a slug`);
        const charge = validateCharge(charge_mode, charge_value);
        if (charge.error) return rejectLink(req, res, 400, charge.error);

        const [existing] = await db.query('SELECT id FROM payment_links WHERE slug = ?', [cleanSlug]);
        if (existing.length) return rejectLink(req, res, 400, 'This payment link URL is already taken');
        const [[limits]] = await db.query(`SELECT r.max_links,(SELECT COUNT(*) FROM payment_links WHERE reseller_id=r.id) link_count FROM resellers r WHERE r.id=?`,[req.reseller.id]);
        if (Number(limits?.max_links)>0 && Number(limits.link_count)>=Number(limits.max_links)) return rejectLink(req, res, 403, 'Your payment-link limit has been reached. Contact the platform owner.');

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
            const [validSub] = await db.query("SELECT id FROM sub_users WHERE id = ? AND reseller_id = ? AND status='active'", [targetId, req.reseller.id]);
            if (!validSub.length) return rejectLink(req, res, 403, 'Select an active sub-user belonging to this account');
            linkSubUserId = targetId;
        }

        await db.query(
            `INSERT INTO payment_links (reseller_id, sub_user_id, slug, title, brand_name, logo_path, domain, theme, amount_type, fixed_amount, min_amount, max_amount, charge_mode, charge_value, preview_mode)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [req.reseller.id, linkSubUserId, cleanSlug, cleanTitle, cleanBrand, logoPath, normalizeDomain(domain, req.get('host')), cleanTheme, amountType, amountType === 'fixed' ? fixed : null, amountType === 'open' ? min : null, amountType === 'open' ? max : null, charge.mode, charge.value, previewMode]
        );
        res.json({ success: true });
    } catch (err) {
        if (req.file?.path) try { fs.unlinkSync(req.file.path); } catch (_) {}
        console.error('[links] Create link error:', err && err.message ? err.message : err);
        res.status(500).json({ error: 'Failed to create payment link' });
    }
});

// Sub-users cannot edit link configuration or fees.
router.put('/api/links/:id', auth, requireRole('reseller', 'owner'), async (req, res) => {
    try {
        const linkId = Number.parseInt(req.params.id, 10);
        if (!Number.isSafeInteger(linkId) || linkId <= 0) return res.status(400).json({ error: 'Invalid payment link ID' });
        const [rows] = await db.query('SELECT id FROM payment_links WHERE id=? AND reseller_id=?', [linkId, req.reseller.id]);
        if (!rows.length) return res.status(404).json({ error: 'Payment link not found' });

        const title = String(req.body.title || '').trim();
        const brand = String(req.body.brand_name || 'Cash Pay').trim();
        const theme = String(req.body.theme || 'default').toLowerCase();
        const domain = normalizeDomain(req.body.domain, req.get('host'));
        const amountType = String(req.body.amount_type || 'open');
        const fixed = Number(req.body.fixed_amount);
        const min = req.body.min_amount === '' || req.body.min_amount == null ? 1 : Number(req.body.min_amount);
        const max = req.body.max_amount === '' || req.body.max_amount == null ? 2000 : Number(req.body.max_amount);
        const charge = validateCharge(req.body.charge_mode, req.body.charge_value);
        const previewMode = String(req.body.preview_mode || 'full').toLowerCase();
        if (!title || title.length > 100) return res.status(400).json({ error: 'Title must be 1–100 characters' });
        if (!brand || brand.length > 60) return res.status(400).json({ error: 'Brand name must be 1–60 characters' });
        if (!/^[a-z0-9_-]{1,30}$/.test(theme)) return res.status(400).json({ error: 'Invalid theme' });
        if (!['open', 'fixed'].includes(amountType)) return res.status(400).json({ error: 'Invalid amount type' });
        if (!['full', 'imessage_compact'].includes(previewMode)) return res.status(400).json({ error: 'Invalid preview mode' });
        if (amountType === 'fixed' && (!Number.isFinite(fixed) || fixed <= 0 || fixed > 1000000)) return res.status(400).json({ error: 'Enter a valid fixed amount' });
        if (amountType === 'open' && (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max < min || max > 1000000)) return res.status(400).json({ error: 'Enter a valid minimum and maximum amount' });
        if (charge.error) return res.status(400).json({ error: charge.error });

        await db.query(
            `UPDATE payment_links SET title=?,brand_name=?,domain=?,theme=?,amount_type=?,fixed_amount=?,min_amount=?,max_amount=?,charge_mode=?,charge_value=?,preview_mode=? WHERE id=? AND reseller_id=?`,
            [title, brand, domain, theme, amountType, amountType === 'fixed' ? fixed : null, amountType === 'open' ? min : null, amountType === 'open' ? max : null, charge.mode, charge.value, previewMode, linkId, req.reseller.id]
        );
        res.json({ success: true });
    } catch (err) {
        console.error('[links] Edit link error:', err && err.message ? err.message : err);
        res.status(500).json({ error: 'Failed to update payment link' });
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
        const [links] = await db.query('SELECT logo_path FROM payment_links WHERE id=? AND reseller_id=?', [req.params.id, req.reseller.id]);
        if (!links.length) return res.status(404).json({ error: 'Payment link not found' });
        const [result] = await db.query('DELETE FROM payment_links WHERE id = ? AND reseller_id = ?', [req.params.id, req.reseller.id]);
        if (!result.affectedRows) return res.status(404).json({ error: 'Payment link not found' });
        if (links[0].logo_path) {
            const uploadRoot = path.resolve(__dirname, '../public/uploads/logos');
            const logoFile = path.resolve(__dirname, `../public${links[0].logo_path}`);
            if (logoFile.startsWith(`${uploadRoot}${path.sep}`)) try { fs.unlinkSync(logoFile); } catch (_) {}
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete payment link' });
    }
});

// Only reseller/owner can assign/reassign links.
router.put('/api/links/:id/assign', auth, requireRole('reseller', 'owner'), async (req, res) => {
    try {
        const { sub_user_id } = req.body;
        const linkId = Number.parseInt(req.params.id, 10);
        if (!Number.isSafeInteger(linkId) || linkId <= 0) return res.status(400).json({ error: 'Invalid payment link ID' });
        const targetId = (sub_user_id && sub_user_id !== 'null' && sub_user_id !== '') ? Number.parseInt(sub_user_id, 10) : null;
        if (targetId !== null && (!Number.isSafeInteger(targetId) || targetId <= 0)) return res.status(400).json({ error: 'Invalid sub-user ID' });

        const [links] = await db.query(
            req.role === 'owner'
                ? 'SELECT id,reseller_id FROM payment_links WHERE id=?'
                : 'SELECT id,reseller_id FROM payment_links WHERE id=? AND reseller_id=?',
            req.role === 'owner' ? [linkId] : [linkId, req.reseller.id]
        );
        if (!links.length) return res.status(404).json({ error: 'Payment link not found' });

        if (targetId !== null) {
            const [validSub] = await db.query("SELECT id FROM sub_users WHERE id=? AND reseller_id=? AND status='active'", [targetId, links[0].reseller_id]);
            if (!validSub.length) return res.status(400).json({ error: 'Select an active merchant belonging to this reseller' });
        }

        const [result] = await db.query('UPDATE payment_links SET sub_user_id=? WHERE id=?', [targetId, linkId]);
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
