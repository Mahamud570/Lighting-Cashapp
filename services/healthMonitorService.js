const fs = require('fs');
const db = require('../database/db');
const BackupService = require('./backupService');
const logger = require('./structuredLogger');

const CACHE_MS = Math.min(15 * 60 * 1000, Math.max(60 * 1000, Number(process.env.HEALTH_CACHE_MS) || 5 * 60 * 1000));
let cached = null;
let running = null;
let timer = null;

async function backupHealth() {
    const dir = BackupService.backupDirectory();
    try {
        const files = (await fs.promises.readdir(dir)).filter(name => /^(daily|weekly)-.*\.(?:sql|db)\.gz$/.test(name));
        const stats = await Promise.all(files.map(async name => ({ name, stat: await fs.promises.stat(require('path').join(dir, name)) })));
        stats.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
        const latest = stats[0];
        if (!latest) return { status: 'warning', message: 'No verified backup found' };
        const ageHours = Math.round((Date.now() - latest.stat.mtimeMs) / 360000) / 10;
        return { status: ageHours <= 30 ? 'ok' : 'warning', message: `Latest backup ${ageHours}h ago`, file: latest.name };
    } catch (_) { return { status: 'warning', message: 'Backup directory is not available yet' }; }
}

async function collect() {
    const started = Date.now();
    const checks = {};
    try { await db.query('SELECT 1 AS ok'); checks.database = { status: 'ok', message: 'Database reachable' }; }
    catch (err) { checks.database = { status: 'critical', message: 'Database unavailable' }; await logger.error('health.database', err); }
    if (checks.database.status === 'ok') {
        const [[backlog]] = await db.query(`SELECT
            SUM(CASE WHEN status='pending' AND expires_at < datetime('now') THEN 1 ELSE 0 END) stale_payments,
            (SELECT COUNT(*) FROM settlement_jobs WHERE status IN ('retry','unknown','failed_permanent')) settlement_attention,
            (SELECT COUNT(*) FROM settlement_jobs WHERE status='processing' AND updated_at < datetime('now','-5 minutes')) stuck_jobs
            FROM payments`);
        checks.settlement = {
            status: Number(backlog.stuck_jobs || 0) ? 'critical' : (Number(backlog.settlement_attention || 0) ? 'warning' : 'ok'),
            message: `${Number(backlog.settlement_attention || 0)} jobs need review`,
            stale_payments: Number(backlog.stale_payments || 0), stuck_jobs: Number(backlog.stuck_jobs || 0)
        };
        const [providers] = await db.query(`SELECT wallet_type, COUNT(*) accounts FROM resellers WHERE role='reseller' AND status='active' GROUP BY wallet_type`);
        checks.providers = { status: 'ok', message: 'Configuration inventory loaded', accounts: providers };
    }
    checks.backup = await backupHealth();
    const statuses = Object.values(checks).map(item => item.status);
    const snapshot = { status: statuses.includes('critical') ? 'critical' : (statuses.includes('warning') ? 'warning' : 'ok'), checked_at: new Date().toISOString(), duration_ms: Date.now() - started, checks };
    cached = snapshot;
    await logger.info('health.snapshot', { status: snapshot.status, duration_ms: snapshot.duration_ms });
    return snapshot;
}
function refresh() { if (!running) running = collect().finally(() => { running = null; }); return running; }
async function getSnapshot() { return cached && Date.now() - Date.parse(cached.checked_at) < CACHE_MS ? cached : refresh(); }
function start() { if (process.env.NODE_ENV === 'test' || timer) return; setTimeout(refresh, 20000).unref(); timer = setInterval(refresh, CACHE_MS); timer.unref(); }
function stop() { if (timer) clearInterval(timer); timer = null; }

module.exports = { getSnapshot, refresh, start, stop };
