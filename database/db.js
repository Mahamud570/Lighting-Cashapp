/**
 * SQLite adapter using sql.js (pure JavaScript/WebAssembly - NO native binaries).
 * Drop-in replacement for the sqlite3-based adapter.
 */
const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, '../data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const dbPath = path.join(dataDir, 'lightning_pay.db');

let db = null;

function saveToDisk() {
    if (!db) return;
    try {
        const data = db.export();
        fs.writeFileSync(dbPath, Buffer.from(data));
    } catch (err) {
        console.error('[db] Error saving to disk', {
            message: err && err.message ? err.message : String(err),
            code: err && err.code ? err.code : undefined,
            path: dbPath,
            stack: err && err.stack ? err.stack : undefined
        });
    }
}

async function initDb() {
    const SQL = await initSqlJs();

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

    ensureColumn('sub_users', 'must_change_password', 'INTEGER DEFAULT 0');
    ensureColumn('sub_users', 'rate_per_dollar', 'REAL DEFAULT 1.0');
    ensureColumn('payment_links', 'sub_user_id', 'INTEGER');
    ensureColumn('payments', 'sub_user_id', 'INTEGER');
    ensureColumn('payments', 'provider', "TEXT DEFAULT 'email'");
    ensureColumn('payments', 'verify_url', 'TEXT');
    ensureColumn('payments', 'payer_location', 'TEXT');
    ensureColumn('payments', 'payer_note', 'TEXT');
    ensureColumn('payments', 'receiving_wallet', 'TEXT');
    ensureColumn('payments', 'seller_checked', 'INTEGER DEFAULT 0');

    // Session identity columns prevent reseller session management from exposing
    // or revoking sub-user sessions that happen to share the same parent reseller_id.
    ensureColumn('sessions', 'account_type', "TEXT DEFAULT 'reseller'");
    ensureColumn('sessions', 'account_id', 'INTEGER');
    try { db.run("UPDATE sessions SET account_type = 'reseller' WHERE account_type IS NULL OR account_type = ''"); } catch (_) {}
    try { db.run('UPDATE sessions SET account_id = reseller_id WHERE account_id IS NULL'); } catch (_) {}

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

    try {
        const bcrypt = require('bcryptjs');
        const adminHash = bcrypt.hashSync('admin123', 10);
        const resellerHash = bcrypt.hashSync('reseller123', 10);
        try {
            db.run(`INSERT INTO resellers (username, email, password, role, status, must_change_password)
                    VALUES ('admin', 'admin@lightningpay.local', '${adminHash}', 'owner', 'active', 0)
                    ON CONFLICT(username) DO NOTHING`);
        } catch (_) {}
        try {
            db.run(`INSERT INTO resellers (username, email, password, role, status, must_change_password)
                    VALUES ('reseller', 'reseller@lightningpay.local', '${resellerHash}', 'reseller', 'active', 0)
                    ON CONFLICT(username) DO NOTHING`);
        } catch (_) {}
    } catch (e) {
        console.error('[db] Seed account warning:', e.message);
    }

    saveToDisk();
    console.log('✅ SQLite (sql.js WASM) database initialized successfully.');
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

        const stmt = db.prepare(converted);
        try { stmt.run(flatParams); }
        finally { stmt.free(); }

        const idResult = db.exec('SELECT last_insert_rowid()');
        const insertId = idResult[0]?.values[0]?.[0] || 0;
        const affectedRows = db.getRowsModified();
        saveToDisk();
        return [{ insertId, affectedRows }, []];
    }
};

const gracefulClose = () => {
    if (db) {
        saveToDisk();
        db.close();
        console.log('[db] SQLite connection closed cleanly.');
    }
};
process.once('SIGTERM', gracefulClose);
process.once('SIGINT', gracefulClose);
process.once('exit', gracefulClose);

module.exports = pool;
