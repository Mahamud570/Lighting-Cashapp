/**
 * SQLite adapter using sql.js (pure JavaScript/WebAssembly - NO native binaries).
 * Drop-in replacement for the sqlite3-based adapter.
 */
const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

const dataDir = path.join(__dirname, '../data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const dbPath = path.join(dataDir, 'lightning_pay.db');
try { fs.chmodSync(dataDir, 0o700); } catch (_) {}
if (fs.existsSync(dbPath)) try { fs.chmodSync(dbPath, 0o600); } catch (_) {}

let db = null;
let SQLRuntime = null;

function formatStorageError(err) {
    const code = String(err?.code || 'UNKNOWN');
    const message = String(err?.message || err || 'Unknown filesystem error');
    return `${code}: ${message}`;
}

function ensureWritableStorage() {
    try {
        fs.accessSync(dataDir, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
        if (fs.existsSync(dbPath)) fs.accessSync(dbPath, fs.constants.R_OK | fs.constants.W_OK);
    } catch (err) {
        throw new Error(`Database storage is not writable (${formatStorageError(err)}). Check ownership and permissions for ${dataDir}.`);
    }
}

function saveToDisk({ throwOnError = true } = {}) {
    if (!db) return;
    const tempPath = `${dbPath}.${process.pid}.tmp`;
    try {
        ensureWritableStorage();
        const data = db.export();
        const fd = fs.openSync(tempPath, 'w', 0o600);
        try {
            fs.writeFileSync(fd, Buffer.from(data));
            fs.fsyncSync(fd);
        } finally {
            fs.closeSync(fd);
        }
        try {
            fs.renameSync(tempPath, dbPath);
        } catch (renameError) {
            // Windows can reject replacing an existing file. The fallback still
            // writes from a fully completed temporary export.
            fs.copyFileSync(tempPath, dbPath);
            fs.unlinkSync(tempPath);
        }
        try { fs.chmodSync(dbPath, 0o600); } catch (_) {}
    } catch (err) {
        try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch (_) {}
        const persistenceError = new Error(`Database persistence failed at ${dbPath}: ${formatStorageError(err)}`);
        console.error('[db] Database persistence failure:', persistenceError.message);
        if (throwOnError) throw persistenceError;
    }
}

async function initDb() {
    const SQL = await initSqlJs();
    SQLRuntime = SQL;

    ensureWritableStorage();

    if (fs.existsSync(dbPath)) {
        const fileBuffer = fs.readFileSync(dbPath);
        db = new SQL.Database(fileBuffer);
    } else {
        db = new SQL.Database();
    }

    db.run('PRAGMA foreign_keys = ON');
    db.run('PRAGMA synchronous = NORMAL');

    const schemaPath = path.join(__dirname, 'schema.sql');
    if (fs.existsSync(schemaPath)) {
        const schema = fs.readFileSync(schemaPath, 'utf8');
        try {
            db.run(schema);
        } catch (e) {
            const statements = schema.split(';').map(s => s.trim()).filter(s => s.length > 0 && !s.startsWith('--'));
            for (const stmt of statements) {
                try { db.run(stmt); } catch (_) {}
            }
        }
    }

    function ensureColumn(tableName, columnName, columnDef) {
        try {
            const info = db.exec(`PRAGMA table_info(${tableName})`);
            if (info && info[0] && info[0].values) {
                const cols = info[0].values.map(v => v[1]);
                if (!cols.includes(columnName)) db.run(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDef}`);
            }
        } catch (_) {}
    }

    ensureColumn('resellers', 'role', "TEXT DEFAULT 'reseller'");
    ensureColumn('resellers', 'blink_api_keys', 'TEXT');
    ensureColumn('resellers', 'lnbits_url', 'TEXT');
    ensureColumn('resellers', 'lnbits_invoice_key', 'TEXT');
    ensureColumn('resellers', 'lnbits_admin_key', 'TEXT');
    ensureColumn('resellers', 'blink_api_key', 'TEXT');
    ensureColumn('resellers', 'blink_wallet_id', 'TEXT');
    ensureColumn('resellers', 'alby_nwc_string', 'TEXT');
    ensureColumn('resellers', 'alby_access_token', 'TEXT');
    ensureColumn('resellers', 'alby_webhook_secret', 'TEXT');
    ensureColumn('resellers', 'binance_api_key', 'TEXT');
    ensureColumn('resellers', 'binance_api_secret', 'TEXT');
    ensureColumn('resellers', 'binance_auto_sweep_enabled', 'INTEGER DEFAULT 0');
    ensureColumn('resellers', 'binance_sweep_threshold_usd', 'REAL DEFAULT 0');
    ensureColumn('resellers', 'binance_sweep_type', "TEXT DEFAULT 'lightning'");
    ensureColumn('resellers', 'auto_payout_enabled', 'INTEGER DEFAULT 0');
    ensureColumn('resellers', 'auto_payout_address', 'TEXT');
    ensureColumn('resellers', 'auto_payout_percent', 'REAL DEFAULT 100');
    ensureColumn('resellers', 'telegram_bot_token', 'TEXT');
    ensureColumn('resellers', 'telegram_chat_id', 'TEXT');
    ensureColumn('resellers', 'binance_sweep_wallet_balance_enabled', 'INTEGER DEFAULT 0');
    ensureColumn('resellers', 'must_change_password', 'INTEGER DEFAULT 0');
    ensureColumn('resellers', 'payments_paused', 'INTEGER DEFAULT 0');
    ensureColumn('resellers', 'require_2fa', 'INTEGER DEFAULT 0');
    ensureColumn('resellers', 'max_payment_usd', 'REAL DEFAULT 0');
    ensureColumn('resellers', 'max_daily_volume_usd', 'REAL DEFAULT 0');
    ensureColumn('resellers', 'max_sub_users', 'INTEGER DEFAULT 0');
    ensureColumn('resellers', 'max_links', 'INTEGER DEFAULT 0');
    ensureColumn('resellers', 'internal_notes', 'TEXT');
    ensureColumn('resellers', 'tags', 'TEXT');

    ensureColumn('sub_users', 'must_change_password', 'INTEGER DEFAULT 0');
    ensureColumn('sub_users', 'rate_per_dollar', 'REAL DEFAULT 1.0');
    ensureColumn('payment_links', 'sub_user_id', 'INTEGER');
    ensureColumn('payment_links', 'charge_mode', "TEXT DEFAULT 'inherit'");
    ensureColumn('payment_links', 'charge_value', 'REAL DEFAULT 0');
    ensureColumn('payment_links', 'preview_mode', "TEXT DEFAULT 'full'");
    ensureColumn('payments', 'sub_user_id', 'INTEGER');
    ensureColumn('payments', 'provider', "TEXT DEFAULT 'email'");
    ensureColumn('payments', 'amount_sats', 'INTEGER');
    ensureColumn('payments', 'verify_url', 'TEXT');
    ensureColumn('payments', 'payer_location', 'TEXT');
    ensureColumn('payments', 'payer_note', 'TEXT');
    ensureColumn('payments', 'receiving_wallet', 'TEXT');
    ensureColumn('payments', 'seller_checked', 'INTEGER DEFAULT 0');
    ensureColumn('payments', 'public_status_token', 'TEXT');
    db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_public_status_token ON payments(public_status_token)');

    // New logins explicitly stamp their real account identity. Legacy sessions are
    // intentionally left unclassified so an old sub-user session can never appear
    // as a reseller session in the new Sessions & Browsers UI.
    ensureColumn('sessions', 'account_type', 'TEXT');
    ensureColumn('sessions', 'account_id', 'INTEGER');

    db.run(`CREATE TABLE IF NOT EXISTS trusted_devices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        reseller_id INTEGER NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        label TEXT,
        ip TEXT,
        user_agent TEXT,
        device_type TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_used DATETIME DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME NOT NULL,
        revoked_at DATETIME,
        FOREIGN KEY (reseller_id) REFERENCES resellers(id) ON DELETE CASCADE
    )`);
    db.run('CREATE INDEX IF NOT EXISTS idx_trusted_devices_owner ON trusted_devices(reseller_id, expires_at)');
    db.run('CREATE INDEX IF NOT EXISTS idx_sessions_owner ON sessions(account_type, account_id, expires_at)');
    db.run('CREATE INDEX IF NOT EXISTS idx_settlement_jobs_due ON settlement_jobs(status, next_retry_at)');
    db.run('CREATE INDEX IF NOT EXISTS idx_platform_wallet_fees_due ON platform_wallet_fees(status, next_retry_at)');
    db.run(`CREATE TABLE IF NOT EXISTS platform_settings (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_by INTEGER,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run(`INSERT OR IGNORE INTO platform_settings (key,value) VALUES
        ('maintenance_mode','0'),('payments_paused','0'),('provider_paused',''),
        ('default_charge_mode','none'),('default_charge_value','0'),
        ('daily_volume_limit_usd','0'),('max_payment_usd','0'),
        ('support_message','Platform operating normally'),
        ('wallet_fee_enabled','0'),('wallet_fee_threshold_usd','200'),
        ('wallet_fee_amount_usd','0.75'),('wallet_fee_lightning_address',''),
        ('lnbits_expiry_date',''),('vps_expiry_date','2026-09-20'),
        ('hosting_expiry_date','2026-09-16'),('domain_expiry_date','2026-09-16')`);
    db.run("UPDATE platform_settings SET value='2026-09-20' WHERE key='vps_expiry_date' AND COALESCE(value,'')=''");
    db.run("UPDATE platform_settings SET value='2026-09-16' WHERE key IN ('hosting_expiry_date','domain_expiry_date') AND COALESCE(value,'')=''");

    try {
        const isTest = process.env.NODE_ENV === 'test';
        if (isTest) {
            const adminHash = bcrypt.hashSync('admin123', 10);
            const resellerHash = bcrypt.hashSync('reseller123', 10);
            db.run(`INSERT INTO resellers (username, email, password, role, status, must_change_password)
                    VALUES ('admin', 'admin@lightningpay.local', '${adminHash}', 'owner', 'active', 0)
                    ON CONFLICT(username) DO UPDATE SET password='${adminHash}', role='owner', status='active', totp_enabled=0, totp_secret=NULL, must_change_password=0`);
            db.run(`INSERT INTO resellers (username, email, password, role, status, must_change_password)
                    VALUES ('reseller', 'reseller@lightningpay.local', '${resellerHash}', 'reseller', 'active', 0)
                    ON CONFLICT(username) DO UPDATE SET password='${resellerHash}', role='reseller', status='active', totp_enabled=0, totp_secret=NULL, must_change_password=0`);
        } else {
            const username = String(process.env.BOOTSTRAP_OWNER_USERNAME || '').trim();
            const email = String(process.env.BOOTSTRAP_OWNER_EMAIL || '').trim();
            const password = String(process.env.BOOTSTRAP_OWNER_PASSWORD || '');
            if (username || email || password) {
                if (!/^[A-Za-z0-9_.-]{3,40}$/.test(username) || !/^\S+@\S+\.\S+$/.test(email) || password.length < 12) {
                    throw new Error('BOOTSTRAP_OWNER_USERNAME, BOOTSTRAP_OWNER_EMAIL and a password of at least 12 characters are required');
                }
                const hash = bcrypt.hashSync(password, 12);
                const stmt = db.prepare(`INSERT INTO resellers (username, email, password, role, status, must_change_password)
                    VALUES (?, ?, ?, 'owner', 'active', 1) ON CONFLICT(username) DO NOTHING`);
                try { stmt.run([username, email.toLowerCase(), hash]); } finally { stmt.free(); }
            }
        }
    } catch (e) {
        if (process.env.NODE_ENV !== 'test') console.error('[db] Bootstrap account warning:', e.message);
    }

    saveToDisk();
    if (process.env.NODE_ENV !== 'test') console.log('✅ SQLite (sql.js WASM) database initialized successfully.');
}

const dbInitPromise = initDb().catch(err => {
    console.error('❌ SQLite initialization error:', err && err.stack ? err.stack : err);
    process.exit(1);
});

function convertSql(sql) {
    return sql
        .replace(/DATE_SUB\(NOW\(\),\s*INTERVAL\s+(\d+)\s+DAY\)/gi, "datetime('now', '-$1 days')")
        .replace(/DATE_SUB\(NOW\(\),\s*INTERVAL\s+(\d+)\s+MINUTE\)/gi, "datetime('now', '-$1 minutes')")
        .replace(/DATE_ADD\(NOW\(\),\s*INTERVAL\s+(\d+)\s+MINUTE\)/gi, "datetime('now', '+$1 minutes')")
        .replace(/DATE_ADD\(NOW\(\),\s*INTERVAL\s+(\d+)\s+DAY\)/gi, "datetime('now', '+$1 days')")
        .replace(/\bNOW\(\)/gi, "datetime('now')")
        .replace(/datetime\("([^"]+)"\)/gi, "datetime('$1')")
        .replace(/\bDATE\(([^)]+)\)/gi, 'date($1)')
        .replace(/=\s*"([a-zA-Z0-9_-]+)"/g, "= '$1'")
        .replace(/!=\s*"([a-zA-Z0-9_-]+)"/g, "!= '$1'")
        .replace(/^INSERT IGNORE /i, 'INSERT OR IGNORE ');
}

function sanitizeParam(p) {
    if (p instanceof Date) return p.toISOString().slice(0, 19).replace('T', ' ');
    return p === undefined ? null : p;
}

const pool = {
    query: async (sql, params = []) => {
        await dbInitPromise;
        const converted = convertSql(sql);
        const upper = converted.trim().toUpperCase();
        const isSelect = upper.startsWith('SELECT') || upper.startsWith('PRAGMA') || upper.startsWith('WITH');
        const flatParams = (Array.isArray(params) ? params.flat() : []).map(sanitizeParam);

        if (isSelect) {
            const rows = [];
            const stmt = db.prepare(converted);
            try {
                stmt.bind(flatParams);
                while (stmt.step()) rows.push(stmt.getAsObject());
            } finally {
                stmt.free();
            }
            return [rows, []];
        }

        // Keep an in-memory snapshot so a failed cPanel filesystem write cannot
        // leave settings changed only until the next process restart.
        const snapshot = db.export();
        const stmt = db.prepare(converted);
        try { stmt.run(flatParams); }
        finally { stmt.free(); }

        const idResult = db.exec('SELECT last_insert_rowid()');
        const insertId = idResult[0]?.values[0]?.[0] || 0;
        const affectedRows = db.getRowsModified();
        try {
            saveToDisk();
        } catch (err) {
            try { db.close(); } catch (_) {}
            db = new SQLRuntime.Database(snapshot);
            throw err;
        }
        return [{ insertId, affectedRows }, []];
    }
};

const gracefulClose = () => {
    if (db) {
        saveToDisk({ throwOnError: false });
        db.close();
        if (process.env.NODE_ENV !== 'test') console.log('[db] SQLite connection closed cleanly.');
    }
};
process.once('SIGTERM', gracefulClose);
process.once('SIGINT', gracefulClose);
process.once('exit', gracefulClose);

module.exports = pool;
