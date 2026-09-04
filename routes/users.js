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
            `SELECT su.id,su.reseller_id,su.name,su.email,su.rate_per_dollar,su.charge_mode,
             su.charge_value,su.status,su.balance_usd,su.must_change_password,su.created_at,
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
        const cleanName = String(name || '').trim();
        const cleanEmail = String(email || '').trim().toLowerCase();
        const cleanPassword = String(password || '');
        if (!cleanName || !cleanEmail || !cleanPassword) return res.status(400).json({ error: 'Name, email, password required' });
        if (cleanName.length < 2 || cleanName.length > 80) return res.status(400).json({ error: 'Name must be 2–80 characters' });
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail) || cleanEmail.length > 254) return res.status(400).json({ error: 'Enter a valid email address' });
        if (cleanPassword.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
        const cleanMode = charge_mode || 'inherit';
        if (!['inherit', 'none', 'fixed', 'percent'].includes(cleanMode)) return res.status(400).json({ error: 'Invalid charge mode' });
        const cleanCharge = Number(charge_value || 0);
        if (!Number.isFinite(cleanCharge) || cleanCharge < 0 || (cleanMode === 'fixed' && cleanCharge > 100) || (cleanMode === 'percent' && cleanCharge > 50)) return res.status(400).json({ error: 'Invalid charge value' });
        const [[limits]] = await db.query(`SELECT r.max_sub_users,(SELECT COUNT(*) FROM sub_users WHERE reseller_id=r.id) user_count FROM resellers r WHERE r.id=?`,[req.reseller.id]);
        if (Number(limits?.max_sub_users)>0 && Number(limits.user_count)>=Number(limits.max_sub_users)) return res.status(403).json({ error: 'Your merchant-account limit has been reached. Contact the platform owner.' });

        const rate = parseFloat(rate_per_dollar);
        if (rate_per_dollar !== undefined && (isNaN(rate) || rate < 0.01 || rate > 100)) {
            return res.status(400).json({ error: 'rate_per_dollar must be between 0.01 and 100' });
        }

        const [existing] = await db.query('SELECT id FROM sub_users WHERE LOWER(email) = LOWER(?)', [cleanEmail]);
        if (existing.length) return res.status(400).json({ error: 'Email already exists' });

        const hash = await bcrypt.hash(cleanPassword, 12);
        await db.query(
            'INSERT INTO sub_users (reseller_id, name, email, password, rate_per_dollar, charge_mode, charge_value, must_change_password) VALUES (?,?,?,?,?,?,?,0)',
            [req.reseller.id, cleanName, cleanEmail, hash, rate || 1, cleanMode, cleanCharge]
        );

        await db.query('INSERT INTO activities (reseller_id,actor,event,description,ip) VALUES (?,?,?,?,?)', [req.reseller.id, req.reseller.username, 'create_sub_user', `Created sub-user ${cleanName}`, req.clientIp || req.ip]);

        res.json({ success: true, temporary_password: cleanPassword });
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
        if (newStatus === 'suspended') await db.query("DELETE FROM sessions WHERE account_type='sub_user' AND account_id=?", [req.params.id]);
        await db.query('INSERT INTO activities (reseller_id,sub_user_id,actor,event,description,ip) VALUES (?,?,?,?,?,?)', [req.reseller.id, user[0].id, req.reseller.username, 'sub_user_status_update', `Set sub-user ${user[0].name} to ${newStatus}`, req.clientIp || req.ip]);
        res.json({ success: true, status: newStatus });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update user status' });
    }
});

router.delete('/api/users/:id', auth, async (req, res) => {
    try {
        const [users] = await db.query('SELECT id,name FROM sub_users WHERE id=? AND reseller_id=?', [req.params.id, req.reseller.id]);
        if (!users.length) return res.status(404).json({ error: 'User not found' });
        await db.query("DELETE FROM sessions WHERE account_type='sub_user' AND account_id=?", [req.params.id]);
        const [result] = await db.query('DELETE FROM sub_users WHERE id = ? AND reseller_id = ?', [req.params.id, req.reseller.id]);
        await db.query('INSERT INTO activities (reseller_id,actor,event,description,ip) VALUES (?,?,?,?,?)', [req.reseller.id, req.reseller.username, 'delete_sub_user', `Deleted sub-user ${users[0].name}`, req.clientIp || req.ip]);
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
