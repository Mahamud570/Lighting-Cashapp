const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawn } = require('child_process');

const DAY_MS = 24 * 60 * 60 * 1000;
let backupTimer = null;
let running = false;

function dateStamp(date = new Date()) {
    return date.toISOString().slice(0, 10);
}

function backupDirectory() {
    return path.resolve(process.env.BACKUP_DIR || path.join(__dirname, '../../lightning-pay-backups'));
}

function ensurePrivateDirectory(dir) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(dir, 0o700); } catch (_) {}
}

function pruneBackups(dir, prefix, keep) {
    const files = fs.readdirSync(dir)
        .filter(name => name.startsWith(prefix) && name.endsWith('.gz'))
        .sort().reverse();
    for (const name of files.slice(keep)) fs.unlinkSync(path.join(dir, name));
}

function locateDumpBinary() {
    const configured = String(process.env.MYSQLDUMP_PATH || '').trim();
    if (configured) return configured;
    for (const candidate of ['/usr/bin/mariadb-dump', '/usr/bin/mysqldump', '/usr/local/bin/mysqldump']) {
        if (fs.existsSync(candidate)) return candidate;
    }
    return 'mysqldump';
}

function dumpMysql(outputPath) {
    return new Promise((resolve, reject) => {
        const args = [
            '--single-transaction', '--quick', '--routines', '--triggers', '--no-tablespaces',
            '--host', process.env.DB_HOST,
            '--port', String(process.env.DB_PORT || 3306),
            '--user', process.env.DB_USER,
            process.env.DB_NAME
        ];
        const child = spawn(locateDumpBinary(), args, {
            env: { ...process.env, MYSQL_PWD: process.env.DB_PASSWORD },
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true
        });
        const gzip = zlib.createGzip({ level: 9 });
        const output = fs.createWriteStream(outputPath, { mode: 0o600 });
        let stderr = '';
        child.stderr.on('data', chunk => { if (stderr.length < 4096) stderr += chunk; });
        child.stdout.pipe(gzip).pipe(output);
        let processDone = false;
        let outputDone = false;
        let settled = false;
        const fail = err => { if (!settled) { settled = true; reject(err); } };
        const finish = () => { if (!settled && processDone && outputDone) { settled = true; resolve(); } };
        child.once('error', fail);
        child.once('close', code => {
            if (code !== 0) return fail(new Error(`database dump exited with code ${code}: ${stderr.trim().slice(0, 500)}`));
            processDone = true;
            finish();
        });
        output.once('error', fail);
        output.once('finish', () => { outputDone = true; finish(); });
    });
}

function dumpSqlite(outputPath) {
    const source = path.join(__dirname, '../data/lightning_pay.db');
    if (!fs.existsSync(source)) throw new Error('SQLite database file was not found');
    return new Promise((resolve, reject) => {
        const input = fs.createReadStream(source);
        const output = fs.createWriteStream(outputPath, { mode: 0o600 });
        input.pipe(zlib.createGzip({ level: 9 })).pipe(output);
        input.once('error', reject);
        output.once('error', reject);
        output.once('finish', resolve);
    });
}

async function createBackup(now = new Date()) {
    if (running) return null;
    running = true;
    const dir = backupDirectory();
    const stamp = dateStamp(now);
    const mysql = String(process.env.DB_ENGINE || '').toLowerCase() === 'mysql' || Boolean(process.env.DB_HOST);
    const extension = mysql ? 'sql.gz' : 'db.gz';
    const dailyPath = path.join(dir, `daily-${stamp}.${extension}`);
    const tempPath = `${dailyPath}.${process.pid}.tmp`;
    try {
        ensurePrivateDirectory(dir);
        if (!fs.existsSync(dailyPath) || fs.statSync(dailyPath).size === 0) {
            if (mysql) await dumpMysql(tempPath); else await dumpSqlite(tempPath);
            if (!fs.existsSync(tempPath) || fs.statSync(tempPath).size === 0) throw new Error('Backup output was empty');
            fs.renameSync(tempPath, dailyPath);
            try { fs.chmodSync(dailyPath, 0o600); } catch (_) {}
        }
        if (now.getUTCDay() === 0) {
            const weeklyPath = path.join(dir, `weekly-${stamp}.${extension}`);
            if (!fs.existsSync(weeklyPath)) fs.copyFileSync(dailyPath, weeklyPath);
            try { fs.chmodSync(weeklyPath, 0o600); } catch (_) {}
        }
        pruneBackups(dir, 'daily-', 7);
        pruneBackups(dir, 'weekly-', 4);
        console.log(`[backup] Verified daily database backup: ${dailyPath}`);
        return dailyPath;
    } catch (err) {
        try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch (_) {}
        throw err;
    } finally {
        running = false;
    }
}

function start() {
    if (process.env.BACKUP_ENABLED === '0' || process.env.NODE_ENV === 'test' || backupTimer) return;
    const run = () => createBackup().catch(err => console.error('[backup] Database backup failed:', err.message));
    setTimeout(run, 15000).unref();
    backupTimer = setInterval(run, DAY_MS);
    backupTimer.unref();
}

function stop() {
    if (backupTimer) clearInterval(backupTimer);
    backupTimer = null;
}

module.exports = { start, stop, createBackup, pruneBackups, backupDirectory, dateStamp };
