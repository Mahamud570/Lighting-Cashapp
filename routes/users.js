const express = require('express');
const router = express.Router();
const db = require('../database/db');
const auth = require('../middleware/auth');
const { requireRole } = auth;
const bcrypt = require('bcryptjs');

router.use('/api/users', auth, requireRole('reseller', 'owner'));

router.get('/api/users', auth, async (req, res) => {
    try {
        const [users] = await db.query(
            `SELECT su.*,
             (SELECT COUNT(*) FROM payment_links pl WHERE pl.sub_user_id = su.id) as link_count,
             (SELECT COUNT(*) FROM withdrawals w WHERE w.sub_user_id = su.id AND w.status='pending') as pending_withdrawals
             FROM sub_users su WHERE su.reseller_id = ? ORDER BY su.created_at DESC`,
            [req.reseller.id]
        );
        res.json(users);
    } catch (err) {
        res.status(500).json({ error: 'Failed to load users' });
    }
});

router.post('/api/users', auth, async (req, res) => {
    try {
        const { name, email, password, rate_per_dollar, charge_mode, charge_value } = req.body;
        if (!name || !email || !password) return res.status(400).json({ error: 'Name, email, password required' });
        if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

        const rate = parseFloat(rate_per_dollar);
        if (rate_per_dollar !== undefined && (isNaN(rate) || rate < 0.01 || rate > 100)) {
            return res.status(400).json({ error: 'rate_per_dollar must be between 0.01 and 100' });
        }

        const [existing] = await db.query('SELECT id FROM sub_users WHERE email = ?', [email]);
        if (existing.length) return res.status(400).json({ error: 'Email already exists' });

        const hash = await bcrypt.hash(password, 12);
        await db.query(
            'INSERT INTO sub_users (reseller_id, name, email, password, rate_per_dollar, charge_mode, charge_value, must_change_password) VALUES (?,?,?,?,?,?,?,0)',
            [req.reseller.id, name, email, hash, rate || 1, charge_mode || 'inherit', charge_value || 0]
        );

        res.json({ success: true, temporary_password: password });
    } catch (err) {
        res.status(500).json({ error: 'Failed to create sub-user' });
    }
});

router.patch('/api/users/:id/status', auth, async (req, res) => {
    try {
        const [user] = await db.query('SELECT * FROM sub_users WHERE id = ? AND reseller_id = ?', [req.params.id, req.reseller.id]);
        if (!user.length) return res.status(404).json({ error: 'User not found' });
        const newStatus = user[0].status === 'active' ? 'suspended' : 'active';
        await db.query('UPDATE sub_users SET status = ? WHERE id = ?', [newStatus, req.params.id]);
        res.json({ success: true, status: newStatus });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update user status' });
    }
});

router.delete('/api/users/:id', auth, async (req, res) => {
    try {
        const [result] = await db.query('DELETE FROM sub_users WHERE id = ? AND reseller_id = ?', [req.params.id, req.reseller.id]);
        res.json({ success: true, deleted: !!result.affectedRows });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete user' });
    }
});

router.get('/api/users/withdrawals', auth, async (req, res) => {
    try {
        const [rows] = await db.query(
            `SELECT w.*, su.name, su.email FROM withdrawals w
             LEFT JOIN sub_users su ON w.sub_user_id = su.id
             WHERE w.reseller_id = ? ORDER BY w.created_at DESC`,
            [req.reseller.id]
        );
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: 'Failed to load withdrawals' });
    }
});

router.patch('/api/users/withdrawals/:id', auth, async (req, res) => {
    try {
        const { status } = req.body;
        if (!['approved', 'rejected'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
        const [result] = await db.query('UPDATE withdrawals SET status = ? WHERE id = ? AND reseller_id = ?', [status, req.params.id, req.reseller.id]);
        if (!result.affectedRows) return res.status(404).json({ error: 'Withdrawal not found' });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update withdrawal' });
    }
});

module.exports = router;
