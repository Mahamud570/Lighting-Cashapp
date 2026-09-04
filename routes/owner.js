const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('../database/db');
const auth = require('../middleware/auth');
const { requireRole } = auth;
const HealthMonitor = require('../services/healthMonitorService');

const SECRET_FIELDS = [
    'opennode_api_key', 'btcpay_api_key', 'btcpay_webhook_secret',
    'lnbits_invoice_key', 'lnbits_admin_key', 'blink_api_key', 'blink_api_keys',
    'alby_access_token', 'alby_nwc_string', 'alby_webhook_secret',
    'binance_api_key', 'binance_api_secret', 'telegram_bot_token'
];
const maskSecret = value => value ? `••••••••${String(value).slice(-4)}` : value;
const isMaskedSecret = value => typeof value === 'string' && value.startsWith('••••••••');

// All owner routes require authenticated owner role
router.use('/api/owner', auth, requireRole('owner'));

router.get('/api/owner/system-health', async (req, res) => {
    try { res.json(await HealthMonitor.getSnapshot()); }
    catch (_) { res.status(503).json({ status: 'critical', error: 'Health snapshot unavailable' }); }
});

router.get('/api/owner/reconciliation', async (req, res) => {
    try {
        const [rows] = await db.query(`SELECT p.id payment_id,p.created_at,p.paid_at,p.total_usd,p.amount_sats,
            r.username reseller,pl.slug,COALESCE(sj.status,'missing') settlement_status,
            sj.operation_key,sj.attempt_count,sj.updated_at,sj.external_reference,
            CASE WHEN sj.id IS NULL AND p.paid_at < datetime('now','-10 minutes') THEN 'attention'
                 WHEN sj.status IN ('unknown','failed_permanent') THEN 'attention'
                 WHEN sj.status IN ('retry','held') THEN 'warning' ELSE 'ok' END health
            FROM payments p JOIN resellers r ON r.id=p.reseller_id
            LEFT JOIN payment_links pl ON pl.id=p.link_id
            LEFT JOIN settlement_jobs sj ON sj.payment_id=p.id
            WHERE p.status='paid' ORDER BY p.paid_at DESC,p.id DESC LIMIT 100`);
        const summary = rows.reduce((out, row) => { out[row.health] = (out[row.health] || 0) + 1; return out; }, { ok: 0, warning: 0, attention: 0 });
        res.json({ checked_at: new Date().toISOString(), summary, rows });
    } catch (_) { res.status(500).json({ error: 'Reconciliation report unavailable' }); }
});

// POST /api/owner/sub-users/:id/preview — short-lived, audited owner preview.
router.post('/api/owner/sub-users/:id/preview', async (req, res) => {
    try {
        const subUserId = Number.parseInt(req.params.id, 10);
        if (!Number.isSafeInteger(subUserId) || subUserId <= 0) return res.status(400).json({ error: 'Invalid sub-user ID' });
        const [rows] = await db.query("SELECT id,reseller_id,name,status FROM sub_users WHERE id=? AND status='active'", [subUserId]);
        if (!rows.length) return res.status(404).json({ error: 'Active sub-user not found' });
        const subUser = rows[0];
        const previewToken = jwt.sign({
            id: subUser.id,
            username: subUser.name,
            role: 'sub_user',
            type: 'sub_user',
            reseller_id: subUser.reseller_id,
            owner_preview: true,
            owner_id: req.reseller.id
        }, process.env.JWT_SECRET, { expiresIn: '30m' });
        const tokenHash = crypto.createHash('sha256').update(previewToken).digest('hex');
        const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
        await db.query(
            'INSERT INTO sessions (reseller_id,account_type,account_id,token_hash,ip,user_agent,device_type,expires_at) VALUES (?,?,?,?,?,?,?,?)',
            [subUser.reseller_id, 'sub_user', subUser.id, tokenHash, req.clientIp || req.ip, req.headers['user-agent'] || '', 'Owner preview', expiresAt]
        );
        await db.query(
            'INSERT INTO activities (reseller_id,sub_user_id,actor,event,description,ip) VALUES (?,?,?,?,?,?)',
            [subUser.reseller_id, subUser.id, req.reseller.username, 'owner_sub_user_preview', `Owner previewed sub-user ${subUser.name} (#${subUser.id})`, req.clientIp || req.ip]
        );
        const cookieOptions = { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', priority: 'high' };
        res.cookie('owner_return_token', req.token, { ...cookieOptions, maxAge: 30 * 60 * 1000 });
        res.cookie('auth_token', previewToken, { ...cookieOptions, maxAge: 30 * 60 * 1000 });
        res.json({ success: true, redirect: '/subuser' });
    } catch (err) {
        console.error('[owner] Sub-user preview error:', err && err.message ? err.message : err);
        res.status(500).json({ error: 'Failed to start sub-user preview' });
    }
});

// GET /api/owner/stats — Global System Overview
router.get('/api/owner/stats', async (req, res) => {
    try {
        const [[resellerCount]] = await db.query(
            "SELECT COUNT(*) as count FROM resellers WHERE role = 'reseller'"
        );

        const [[subUserCount]] = await db.query(
            "SELECT COUNT(*) as count FROM sub_users"
        );

        const [[paymentStats]] = await db.query(
            `SELECT 
                COUNT(*) as total_payments,
                SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END) as paid_count,
                COALESCE(SUM(CASE WHEN status = 'paid' THEN total_usd ELSE 0 END), 0) as total_volume_usd,
                COALESCE(SUM(CASE WHEN status = 'paid' THEN btc_amount ELSE 0 END), 0) as total_btc
             FROM payments`
        );

        const [[linkStats]] = await db.query(
            "SELECT COUNT(*) as total_links FROM payment_links WHERE status = 'active'"
        );

        res.json({
            resellers: resellerCount?.count || 0,
            sub_users: subUserCount?.count || 0,
            total_links: linkStats?.total_links || 0,
            total_payments: paymentStats?.total_payments || 0,
            paid_count: paymentStats?.paid_count || 0,
            total_volume_usd: Number(paymentStats?.total_volume_usd || 0).toFixed(2),
            total_volume_sats: Math.round(Number(paymentStats?.total_btc || 0) * 100_000_000)
        });
    } catch (err) {
        console.error('[owner] Stats error:', err);
        res.status(500).json({ error: 'Failed to fetch owner platform stats' });
    }
});

// GET /api/owner/resellers — List All Reseller Panels
router.get('/api/owner/resellers', async (req, res) => {
    try {
        const [resellers] = await db.query(
            `SELECT 
                r.id, r.username, r.email, r.role, r.status, r.wallet_type, r.created_at,
                r.must_change_password,
                (SELECT COUNT(*) FROM sub_users su WHERE su.reseller_id = r.id) as sub_user_count,
                (SELECT COUNT(*) FROM payment_links pl WHERE pl.reseller_id = r.id) as link_count,
                COALESCE((SELECT SUM(total_usd) FROM payments p WHERE p.reseller_id = r.id AND p.status = 'paid'), 0) as paid_volume_usd
             FROM resellers r
             WHERE r.role = 'reseller'
             ORDER BY r.created_at DESC`
        );

        res.json(resellers.map(r => ({
            ...r,
            paid_volume_usd: Number(r.paid_volume_usd).toFixed(2)
        })));
    } catch (err) {
        console.error('[owner] List resellers error:', err);
        res.status(500).json({ error: 'Failed to fetch resellers list' });
    }
});

// GET /api/owner/resellers/:id — Fetch Single Reseller Complete Config
router.get('/api/owner/resellers/:id', async (req, res) => {
    try {
        const resellerId = parseInt(req.params.id, 10);
        const [rows] = await db.query('SELECT * FROM resellers WHERE id = ?', [resellerId]);
        if (!rows.length) return res.status(404).json({ error: 'Reseller not found' });
        
        const r = rows[0];
        delete r.password; // Do not return bcrypt hash
        for (const field of SECRET_FIELDS) r[field] = maskSecret(r[field]);
        res.json(r);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch reseller configuration' });
    }
});

// POST /api/owner/resellers — Generate & Sell New Reseller Panel
router.post('/api/owner/resellers', async (req, res) => {
    try {
        const { username, email, password } = req.body;

        if (!username || !email || !password) {
            return res.status(400).json({ error: 'Username, email, and password are required' });
        }

        if (password.length < 8) {
            return res.status(400).json({ error: 'Password must be at least 8 characters' });
        }

        if (!/^[a-zA-Z0-9_]{3,30}$/.test(username)) {
            return res.status(400).json({ error: 'Username must be 3–30 characters (letters, numbers, underscore)' });
        }

        const [existing] = await db.query(
            'SELECT id FROM resellers WHERE username = ? OR email = ?',
            [username, email]
        );
        if (existing.length) {
            return res.status(400).json({ error: 'Username or email already taken' });
        }

        const hash = await bcrypt.hash(password, 12);
        const [result] = await db.query(
            "INSERT INTO resellers (username, email, password, role, status, must_change_password) VALUES (?, ?, ?, 'reseller', 'active', 1)",
            [username, email, hash]
        );

        await db.query(
            'INSERT INTO activities (reseller_id, actor, event, description, ip) VALUES (?, ?, ?, ?, ?)',
            [req.reseller.id, req.reseller.username, 'create_reseller_panel', `Generated panel for ${username}`, req.clientIp]
        );

        res.json({
            success: true,
            message: `Reseller panel for ${username} created successfully`,
            reseller: {
                id: result.insertId,
                username,
                email,
                temporary_password: password,
                role: 'reseller',
                status: 'active'
            }
        });
    } catch (err) {
        console.error('[owner] Create reseller error:', err);
        res.status(500).json({ error: 'Failed to generate reseller panel' });
    }
});

// PUT /api/owner/resellers/:id/config — Master Owner Full Config Update
router.put('/api/owner/resellers/:id/config', async (req, res) => {
    try {
        const resellerId = parseInt(req.params.id, 10);
        const [rows] = await db.query('SELECT id FROM resellers WHERE id = ?', [resellerId]);
        if (!rows.length) return res.status(404).json({ error: 'Reseller not found' });

        const {
            username, email, password, status,
            wallet_type, wallet_email,
            blink_api_key, blink_api_keys, blink_wallet_id,
            lnbits_url, lnbits_invoice_key, lnbits_admin_key,
            opennode_api_key, opennode_env,
            alby_access_token, alby_nwc_string,
            binance_api_key, binance_api_secret,
            binance_auto_sweep_enabled, binance_sweep_threshold_usd,
            binance_sweep_type, binance_sweep_wallet_balance_enabled,
            auto_payout_enabled, auto_payout_address, auto_payout_percent,
            telegram_bot_token, telegram_chat_id,
            charge_mode, charge_value
        } = req.body;

        const updates = [];
        const params = [];

        const addField = (col, val) => {
            if (val !== undefined) {
                updates.push(`${col} = ?`);
                params.push(val);
            }
        };
        const addSecretField = (col, val) => {
            if (val !== undefined && !isMaskedSecret(val)) addField(col, val);
        };

        if (username) addField('username', username.trim());
        if (email) addField('email', email.trim());
        if (password && password.length >= 8) {
            const hash = await bcrypt.hash(password, 12);
            addField('password', hash);
            addField('must_change_password', 0);
            // Revoke sessions when password is changed via master config
            await db.query('DELETE FROM sessions WHERE reseller_id = ?', [resellerId]).catch(() => {});
        }

        addField('status', status);
        addField('wallet_type', wallet_type);
        addField('wallet_email', wallet_email);
        addSecretField('blink_api_key', blink_api_key);
        addSecretField('blink_api_keys', blink_api_keys);
        addField('blink_wallet_id', blink_wallet_id);
        addField('lnbits_url', lnbits_url);
        addSecretField('lnbits_invoice_key', lnbits_invoice_key);
        addSecretField('lnbits_admin_key', lnbits_admin_key);
        addSecretField('opennode_api_key', opennode_api_key);
        addField('opennode_env', opennode_env);
        addSecretField('alby_access_token', alby_access_token);
        addSecretField('alby_nwc_string', alby_nwc_string);
        addSecretField('binance_api_key', binance_api_key);
        addSecretField('binance_api_secret', binance_api_secret);
        addField('binance_auto_sweep_enabled', binance_auto_sweep_enabled ? 1 : 0);
        addField('binance_sweep_threshold_usd', binance_sweep_threshold_usd);
        addField('binance_sweep_type', binance_sweep_type);
        addField('binance_sweep_wallet_balance_enabled', binance_sweep_wallet_balance_enabled ? 1 : 0);
        addField('auto_payout_enabled', auto_payout_enabled ? 1 : 0);
        addField('auto_payout_address', auto_payout_address);
        addField('auto_payout_percent', auto_payout_percent);
        addSecretField('telegram_bot_token', telegram_bot_token);
        addField('telegram_chat_id', telegram_chat_id);
        addField('charge_mode', charge_mode);
        addField('charge_value', charge_value);

        if (!updates.length) {
            return res.status(400).json({ error: 'No configuration fields provided for update' });
        }

        params.push(resellerId);
        await db.query(`UPDATE resellers SET ${updates.join(', ')} WHERE id = ?`, params);

        await db.query(
            'INSERT INTO activities (reseller_id, actor, event, description, ip) VALUES (?, ?, ?, ?, ?)',
            [req.reseller.id, req.reseller.username, 'master_config_update', `Full configuration updated for reseller #${resellerId}`, req.clientIp]
        );

        res.json({ success: true, message: `Configuration updated for reseller #${resellerId}` });
    } catch (err) {
        console.error('[owner] Config update error:', err);
        res.status(500).json({ error: 'Failed to update reseller configuration' });
    }
});

// PUT /api/owner/resellers/:id/status — Toggle Suspend / Activate
router.put('/api/owner/resellers/:id/status', async (req, res) => {
    try {
        const { status } = req.body;
        if (!['active', 'suspended'].includes(status)) {
            return res.status(400).json({ error: "Status must be 'active' or 'suspended'" });
        }

        const resellerId = parseInt(req.params.id, 10);
        if (resellerId === req.reseller.id) {
            return res.status(400).json({ error: 'Owner cannot suspend their own account' });
        }

        await db.query('UPDATE resellers SET status = ? WHERE id = ?', [status, resellerId]);

        // If suspending, revoke all active sessions immediately
        if (status === 'suspended') {
            await db.query('DELETE FROM sessions WHERE reseller_id = ?', [resellerId]).catch(() => {});
        }

        await db.query(
            'INSERT INTO activities (reseller_id, actor, event, description, ip) VALUES (?, ?, ?, ?, ?)',
            [req.reseller.id, req.reseller.username, 'update_reseller_status', `Updated reseller ${resellerId} status to ${status}`, req.clientIp]
        );

        res.json({ success: true, message: `Reseller status set to ${status}` });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update reseller status' });
    }
});

// POST /api/owner/resellers/:id/reset-password — Reset Reseller Password
router.post('/api/owner/resellers/:id/reset-password', async (req, res) => {
    try {
        const { new_password } = req.body;
        if (!new_password || new_password.length < 8) {
            return res.status(400).json({ error: 'New password must be at least 8 characters' });
        }

        const resellerId = parseInt(req.params.id, 10);
        const hash = await bcrypt.hash(new_password, 12);

        await db.query('UPDATE resellers SET password = ?, must_change_password = 1 WHERE id = ?', [hash, resellerId]);

        // Revoke all existing sessions so old logins are invalidated
        await db.query('DELETE FROM sessions WHERE reseller_id = ?', [resellerId]).catch(() => {});

        res.json({ success: true, message: 'Reseller password updated successfully', temporary_password: new_password });
    } catch (err) {
        res.status(500).json({ error: 'Failed to reset reseller password' });
    }
});

// GET /api/owner/sub-users — List All Merchant Sub-Users Across Platform
router.get('/api/owner/sub-users', async (req, res) => {
    try {
        const [subUsers] = await db.query(
            `SELECT 
                su.id, su.name, su.email, su.rate_per_dollar, su.status, su.created_at,
                su.must_change_password,
                r.username as reseller_username, r.email as reseller_email
             FROM sub_users su
             JOIN resellers r ON su.reseller_id = r.id
             ORDER BY su.created_at DESC`
        );

        res.json(subUsers);
    } catch (err) {
        console.error('[owner] List sub-users error:', err);
        res.status(500).json({ error: 'Failed to fetch sub-users list' });
    }
});

// POST /api/owner/sub-users/:id/reset-password — Reset Merchant Sub-User Password
router.post('/api/owner/sub-users/:id/reset-password', async (req, res) => {
    try {
        const { new_password } = req.body;
        if (!new_password || new_password.length < 8) {
            return res.status(400).json({ error: 'New password must be at least 8 characters' });
        }

        const subUserId = parseInt(req.params.id, 10);
        const hash = await bcrypt.hash(new_password, 12);

        await db.query('UPDATE sub_users SET password = ?, must_change_password = 1 WHERE id = ?', [hash, subUserId]);

        res.json({ success: true, message: 'Merchant sub-user password updated successfully', temporary_password: new_password });
    } catch (err) {
        res.status(500).json({ error: 'Failed to reset sub-user password' });
    }
});

// Remove access without destroying history.
router.put('/api/owner/sub-users/:id/status', async (req, res) => {
    try {
        const id = Number(req.params.id);
        const status = req.body?.status;
        if (!['active','suspended'].includes(status)) return res.status(400).json({error:'Invalid sub-user status'});
        const [rows] = await db.query('SELECT id,name,reseller_id FROM sub_users WHERE id=?',[id]);
        if (!rows.length) return res.status(404).json({error:'Sub-user not found'});
        await db.query('UPDATE sub_users SET status=? WHERE id=?',[status,id]);
        if (status === 'suspended') await db.query("DELETE FROM sessions WHERE account_type='sub_user' AND account_id=?",[id]).catch(()=>{});
        await db.query('INSERT INTO activities (reseller_id,actor,event,description,ip) VALUES (?,?,?,?,?)',[req.reseller.id,req.reseller.username,'sub_user_status_update',`${status} sub-user ${rows[0].name} (#${id})`,req.clientIp||req.ip]);
        res.json({success:true,message:`Sub-user ${status}`});
    } catch(err){res.status(500).json({error:'Failed to update sub-user status'});}
});

// Permanent deletion is deliberately protected by a typed confirmation.
router.delete('/api/owner/sub-users/:id', async (req, res) => {
    try {
        const id=Number(req.params.id);
        const [rows]=await db.query('SELECT id,name,email,reseller_id FROM sub_users WHERE id=?',[id]);
        if(!rows.length) return res.status(404).json({error:'Sub-user not found'});
        const target=rows[0];
        if(req.body?.confirmation !== `DELETE ${target.name}`) return res.status(400).json({error:`Type DELETE ${target.name} to confirm`});
        await db.query('INSERT INTO activities (reseller_id,actor,event,description,ip) VALUES (?,?,?,?,?)',[req.reseller.id,req.reseller.username,'permanent_sub_user_delete',`Permanently deleted sub-user ${target.name} (${target.email}) #${id}`,req.clientIp||req.ip]);
        await db.query('DELETE FROM sub_users WHERE id=?',[id]);
        res.json({success:true,message:`Sub-user ${target.name} permanently deleted`});
    } catch(err){res.status(500).json({error:'Failed to permanently delete sub-user'});}
});

router.delete('/api/owner/resellers/:id', async (req, res) => {
    try {
        const id=Number(req.params.id);
        const [rows]=await db.query("SELECT id,username,email FROM resellers WHERE id=? AND role='reseller'",[id]);
        if(!rows.length) return res.status(404).json({error:'Reseller not found'});
        const target=rows[0];
        if(req.body?.confirmation !== `DELETE ${target.username}`) return res.status(400).json({error:`Type DELETE ${target.username} to confirm`});
        await db.query('INSERT INTO activities (reseller_id,actor,event,description,ip) VALUES (?,?,?,?,?)',[req.reseller.id,req.reseller.username,'permanent_reseller_delete',`Permanently deleted reseller ${target.username} (${target.email}) #${id} and its dependent records`,req.clientIp||req.ip]);
        await db.query('DELETE FROM resellers WHERE id=?',[id]);
        res.json({success:true,message:`Reseller ${target.username} and its panel were permanently deleted`});
    } catch(err){res.status(500).json({error:'Failed to permanently delete reseller'});}
});

async function ownerAudit(req, event, description) {
    await db.query(
        'INSERT INTO activities (reseller_id, actor, event, description, ip, device) VALUES (?,?,?,?,?,?)',
        [req.reseller.id, req.reseller.username, event, description, req.clientIp || req.ip, req.headers['user-agent'] || 'owner-panel']
    ).catch(() => {});
}

// Complete owner command-center data in one bounded request.
router.get('/api/owner/command-center', async (req, res) => {
    try {
        const [[today]] = await db.query(`SELECT
            COUNT(*) total,
            SUM(CASE WHEN status='paid' THEN 1 ELSE 0 END) paid,
            SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) pending,
            SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) failed,
            SUM(CASE WHEN status='expired' THEN 1 ELSE 0 END) expired,
            COALESCE(SUM(CASE WHEN status='paid' THEN total_usd ELSE 0 END),0) volume
            FROM payments WHERE created_at >= date('now')`);
        const [trend] = await db.query(`WITH RECURSIVE days(day) AS (
            SELECT date('now','-6 days') UNION ALL SELECT date(day,'+1 day') FROM days WHERE day < date('now')
        ) SELECT day, COALESCE(SUM(CASE WHEN p.status='paid' THEN p.total_usd ELSE 0 END),0) volume,
            COUNT(p.id) payments FROM days LEFT JOIN payments p ON date(p.created_at)=day GROUP BY day ORDER BY day`);
        const [wallets] = await db.query(`SELECT r.id,r.username,r.wallet_type,r.wallet_email,r.status,r.payments_paused,
            r.totp_enabled,r.require_2fa,r.created_at,
            CASE WHEN r.wallet_type IS NULL THEN 'unconfigured'
                 WHEN r.wallet_type='email' AND COALESCE(r.wallet_email,'')='' THEN 'warning'
                 WHEN r.wallet_type='blink' AND COALESCE(r.blink_api_key,r.blink_api_keys,'')='' THEN 'warning'
                 WHEN r.wallet_type='lnbits' AND (COALESCE(r.lnbits_url,'')='' OR COALESCE(r.lnbits_invoice_key,'')='') THEN 'warning'
                 WHEN r.wallet_type='opennode' AND COALESCE(r.opennode_api_key,'')='' THEN 'warning'
                 WHEN r.wallet_type='alby' AND COALESCE(r.alby_access_token,r.alby_nwc_string,'')='' THEN 'warning'
                 ELSE 'ready' END health,
            (SELECT MAX(created_at) FROM payments p WHERE p.reseller_id=r.id) last_payment,
            (SELECT COALESCE(SUM(total_usd),0) FROM payments p WHERE p.reseller_id=r.id AND p.status='paid' AND p.created_at>=date('now')) today_volume
            FROM resellers r WHERE r.role='reseller' ORDER BY health DESC,r.username`);
        const [payments] = await db.query(`SELECT p.id,p.created_at,p.total_usd,p.status,p.provider,p.receiving_wallet,
            r.username reseller,pl.slug FROM payments p LEFT JOIN resellers r ON r.id=p.reseller_id
            LEFT JOIN payment_links pl ON pl.id=p.link_id ORDER BY p.created_at DESC LIMIT 30`);
        const [activities] = await db.query(`SELECT a.id,a.actor,a.event,a.description,a.ip,a.created_at,
            r.username account FROM activities a LEFT JOIN resellers r ON r.id=a.reseller_id
            ORDER BY a.created_at DESC LIMIT 40`);
        const [settingsRows] = await db.query('SELECT key,value,updated_at FROM platform_settings');
        const settings = Object.fromEntries(settingsRows.map(s => [s.key, s.value]));
        const [[security]] = await db.query(`SELECT
            (SELECT COUNT(*) FROM sessions WHERE expires_at > datetime('now')) active_sessions,
            (SELECT COUNT(*) FROM trusted_devices WHERE revoked_at IS NULL AND expires_at > datetime('now')) trusted_devices,
            (SELECT COUNT(*) FROM resellers WHERE role='reseller' AND totp_enabled=1) twofa_accounts,
            (SELECT COUNT(*) FROM activities WHERE event LIKE 'login%' AND created_at>=datetime('now','-24 hours')) logins_24h`);
        const alerts = [];
        const badWallets = wallets.filter(w => w.health !== 'ready');
        if (badWallets.length) alerts.push({level:'warning',icon:'⚡',title:`${badWallets.length} wallet configuration${badWallets.length === 1 ? '' : 's'} need attention`,detail:'Open Wallet Health to review missing provider credentials.'});
        if (settings.maintenance_mode === '1') alerts.push({level:'danger',icon:'🚧',title:'Maintenance mode is enabled',detail:'Public payment creation should remain paused during maintenance.'});
        if (settings.payments_paused === '1') alerts.push({level:'danger',icon:'⏸️',title:'Platform payments are paused',detail:'No new production invoices can be created.'});
        for (const [key,label] of [['vps_expiry_date','VPS'],['hosting_expiry_date','Hosting'],['domain_expiry_date','Domain']]) {
            if (!settings[key]) continue;
            const expiry = new Date(`${settings[key]}T23:59:59Z`);
            if (Number.isNaN(expiry.getTime())) continue;
            const days = Math.ceil((expiry.getTime() - Date.now()) / 86400000);
            if (days < 0) alerts.push({level:'danger',icon:'🚨',title:`${label} expired`,detail:`Expired ${Math.abs(days)} day${Math.abs(days)===1?'':'s'} ago. Renew immediately.`});
            else if (days <= 7) alerts.push({level:'danger',icon:'⏰',title:`${label} expires in ${days} day${days===1?'':'s'}`,detail:`Renew before ${settings[key]}.`});
            else if (days <= 30) alerts.push({level:'warning',icon:'📅',title:`${label} renewal due soon`,detail:`${days} days remaining; expires ${settings[key]}.`});
        }
        const no2fa = wallets.filter(w => !Number(w.totp_enabled)).length;
        if (no2fa) alerts.push({level:'info',icon:'🛡️',title:`${no2fa} reseller account${no2fa === 1 ? '' : 's'} without 2FA`,detail:'Consider requiring two-factor authentication for privileged resellers.'});
        if (!alerts.length) alerts.push({level:'success',icon:'✅',title:'All systems look healthy',detail:'No configuration or security warnings detected.'});
        res.json({today:{...today,volume:Number(today.volume||0)},trend,wallets,payments,activities,settings,security,alerts});
    } catch (err) {
        console.error('[owner] Command center error:', err);
        res.status(500).json({error:'Failed to load owner command center'});
    }
});

router.put('/api/owner/platform-settings', async (req, res) => {
    try {
        const allowed = new Set(['maintenance_mode','payments_paused','provider_paused','default_charge_mode','default_charge_value','daily_volume_limit_usd','max_payment_usd','support_message','wallet_fee_enabled','wallet_fee_threshold_usd','wallet_fee_amount_usd','wallet_fee_lightning_address','vps_expiry_date','hosting_expiry_date','domain_expiry_date']);
        const entries = Object.entries(req.body || {}).filter(([key]) => allowed.has(key));
        if (!entries.length) return res.status(400).json({error:'No supported settings supplied'});
        const boolKeys = new Set(['maintenance_mode','payments_paused','wallet_fee_enabled']);
        const requestedFeeEnabled = entries.some(([key, raw]) => key === 'wallet_fee_enabled' && (raw === true || raw === 1 || raw === '1'));
        const submittedAddress = String(req.body?.wallet_fee_lightning_address || '').trim();
        if (requestedFeeEnabled && !/^[^@\s]{1,64}@[A-Za-z0-9.-]{1,253}$/.test(submittedAddress)) {
            return res.status(400).json({error:'A valid owner Lightning address is required before enabling Wallet Fee'});
        }
        for (const [key, raw] of entries) {
            let value = String(raw ?? '').trim();
            if (boolKeys.has(key)) value = raw === true || raw === 1 || raw === '1' ? '1' : '0';
            if (['default_charge_value','daily_volume_limit_usd','max_payment_usd','wallet_fee_threshold_usd','wallet_fee_amount_usd'].includes(key)) value = String(Math.max(0, Number(value)||0));
            if (key === 'wallet_fee_amount_usd' && Number(value) !== 0.75) return res.status(400).json({error:'Wallet Fee must be exactly $0.75'});
            if (key === 'wallet_fee_lightning_address' && value && !/^[^@\s]{1,64}@[A-Za-z0-9.-]{1,253}$/.test(value)) return res.status(400).json({error:'Invalid owner Lightning address'});
            if (['vps_expiry_date','hosting_expiry_date','domain_expiry_date'].includes(key) && value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) return res.status(400).json({error:`Invalid ${key.replaceAll('_',' ')}`});
            if (key === 'default_charge_mode' && !['none','fixed','percent'].includes(value)) return res.status(400).json({error:'Invalid default charge mode'});
            await db.query(`INSERT INTO platform_settings (key,value,updated_by,updated_at) VALUES (?,?,?,datetime('now'))
                ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_by=excluded.updated_by,updated_at=datetime('now')`, [key,value,req.reseller.id]);
        }
        await ownerAudit(req,'platform_settings_update',`Updated platform settings: ${entries.map(([k])=>k).join(', ')}`);
        res.json({success:true,message:'Platform controls updated'});
    } catch (err) { res.status(500).json({error:'Failed to update platform controls'}); }
});

router.put('/api/owner/resellers/:id/controls', async (req, res) => {
    try {
        const id = Number(req.params.id);
        const [found] = await db.query("SELECT id,username FROM resellers WHERE id=? AND role='reseller'",[id]);
        if (!found.length) return res.status(404).json({error:'Reseller not found'});
        const allowed = {
            payments_paused:v=>v?1:0, require_2fa:v=>v?1:0,
            max_payment_usd:v=>Math.max(0,Number(v)||0), max_daily_volume_usd:v=>Math.max(0,Number(v)||0),
            max_sub_users:v=>Math.max(0,Math.floor(Number(v)||0)), max_links:v=>Math.max(0,Math.floor(Number(v)||0)),
            internal_notes:v=>String(v||'').slice(0,2000), tags:v=>String(v||'').slice(0,300),
            charge_mode:v=>['none','fixed','percent'].includes(v)?v:'none', charge_value:v=>Math.max(0,Number(v)||0)
        };
        const updates=[],params=[];
        for (const [key,convert] of Object.entries(allowed)) if (Object.prototype.hasOwnProperty.call(req.body||{},key)) { updates.push(`${key}=?`); params.push(convert(req.body[key])); }
        if (!updates.length) return res.status(400).json({error:'No reseller controls supplied'});
        params.push(id); await db.query(`UPDATE resellers SET ${updates.join(',')} WHERE id=?`,params);
        if (req.body.payments_paused) await db.query('UPDATE payment_links SET status=\'inactive\' WHERE reseller_id=?',[id]);
        await ownerAudit(req,'reseller_controls_update',`Updated limits and controls for ${found[0].username}`);
        res.json({success:true,message:'Reseller controls saved'});
    } catch (err) { res.status(500).json({error:'Failed to update reseller controls'}); }
});

router.post('/api/owner/resellers/:id/revoke-sessions', async (req, res) => {
    const id=Number(req.params.id);
    await db.query('DELETE FROM sessions WHERE reseller_id=?',[id]);
    await db.query('DELETE FROM trusted_devices WHERE reseller_id=?',[id]).catch(()=>{});
    await ownerAudit(req,'revoke_reseller_sessions',`Revoked sessions and trusted devices for reseller #${id}`);
    res.json({success:true,message:'All reseller sessions and trusted browsers revoked'});
});

router.get('/api/owner/resellers/:id/diagnostic', async (req, res) => {
    try {
        const id=Number(req.params.id);
        const [rows]=await db.query(`SELECT id,username,email,status,wallet_type,wallet_email,payments_paused,totp_enabled,require_2fa,
            max_payment_usd,max_daily_volume_usd,max_sub_users,max_links,internal_notes,tags,
            CASE WHEN wallet_type IS NULL THEN 0 WHEN wallet_type='email' THEN COALESCE(wallet_email,'')!=''
                 WHEN wallet_type='blink' THEN COALESCE(blink_api_key,blink_api_keys,'')!=''
                 WHEN wallet_type='lnbits' THEN COALESCE(lnbits_url,'')!='' AND COALESCE(lnbits_invoice_key,'')!=''
                 WHEN wallet_type='opennode' THEN COALESCE(opennode_api_key,'')!=''
                 WHEN wallet_type='alby' THEN COALESCE(alby_access_token,alby_nwc_string,'')!='' ELSE 0 END provider_configured,
            COALESCE(telegram_bot_token,'')!='' AND COALESCE(telegram_chat_id,'')!='' telegram_configured
            FROM resellers WHERE id=? AND role='reseller'`,[id]);
        if(!rows.length) return res.status(404).json({error:'Reseller not found'});
        const [[counts]]=await db.query(`SELECT
            (SELECT COUNT(*) FROM payment_links WHERE reseller_id=?) links,
            (SELECT COUNT(*) FROM sub_users WHERE reseller_id=?) merchants,
            (SELECT COUNT(*) FROM sessions WHERE reseller_id=? AND expires_at>datetime('now')) sessions,
            (SELECT COUNT(*) FROM payments WHERE reseller_id=? AND status='failed' AND created_at>=datetime('now','-24 hours')) failed_24h`,[id,id,id,id]);
        res.json({...rows[0],counts,checked_at:new Date().toISOString()});
    } catch(err){res.status(500).json({error:'Failed to build diagnostic report'});}
});

module.exports = router;
