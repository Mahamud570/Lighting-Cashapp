/**
 * SQLite adapter using sql.js (pure JavaScript/WebAssembly - NO native binaries).
 * Drop-in replacement for the sqlite3-based adapter.
 * Mimics the mysql2 promise pool API.
 * All routes use: const [rows] = await db.query(sql, params)
 *                 const [result] = await db.query(INSERT...) → result.insertId
 */
const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, '../data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const dbPath = path.join(dataDir, 'lightning_pay.db');

let db = null;

// Persist the in-memory database back to disk after writes
function saveToDisk() {
    if (!db) return;
    try {
        const data = db.export();
        fs.writeFileSync(dbPath, Buffer.from(data));
    } catch (err) {
        console.error('[db] Error saving to disk:', err.message);
    }
}

// Initialize database schema and migrations
async function initDb() {
    const SQL = await initSqlJs();

    // Load existing database file if it exists, otherwise start fresh
    if (fs.existsSync(dbPath)) {
        const fileBuffer = fs.readFileSync(dbPath);
        db = new SQL.Database(fileBuffer);
    } else {
        db = new SQL.Database();
    }

    db.run('PRAGMA foreign_keys = ON');
    db.run('PRAGMA synchronous = NORMAL');

    // Run schema file
    const schemaPath = path.join(__dirname, 'schema.sql');
    if (fs.existsSync(schemaPath)) {
        const schema = fs.readFileSync(schemaPath, 'utf8');
        try {
            db.run(schema);
        } catch (e) {
            // Fallback for statements if tables already exist
            const statements = schema
                .split(';')
                .map(s => s.trim())
                .filter(s => s.length > 0 && !s.startsWith('--'));
            for (const stmt of statements) {
                try { db.run(stmt); } catch (_) {}
            }
        }
    }

    // Ensure all dynamic columns exist across tables
    function ensureColumn(tableName, columnName, columnDef) {
        try {
            const info = db.exec(`PRAGMA table_info(${tableName})`);
            if (info && info[0] && info[0].values) {
                const cols = info[0].values.map(v => v[1]);
                if (!cols.includes(columnName)) {
                    db.run(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDef}`);
                }
            }
        } catch (_) {}
    }

    // Resellers migrations
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

    // Sub-users migrations
    ensureColumn('sub_users', 'must_change_password', 'INTEGER DEFAULT 0');
    ensureColumn('sub_users', 'rate_per_dollar', 'REAL DEFAULT 1.0');

    // Payment links migrations
    ensureColumn('payment_links', 'sub_user_id', 'INTEGER');

    // Payments migrations
    ensureColumn('payments', 'sub_user_id', 'INTEGER');
    ensureColumn('payments', 'provider', "TEXT DEFAULT 'email'");
    ensureColumn('payments', 'verify_url', 'TEXT');
    ensureColumn('payments', 'payer_location', 'TEXT');
    ensureColumn('payments', 'payer_note', 'TEXT');
    ensureColumn('payments', 'receiving_wallet', 'TEXT');
    ensureColumn('payments', 'seller_checked', 'INTEGER DEFAULT 0');

    // Seed default Owner and Reseller accounts ONLY if they do not already exist (preserves changed passwords)
    try {
        const bcrypt = require('bcryptjs');
        const adminHash = bcrypt.hashSync('admin123', 10);
        const resellerHash = bcrypt.hashSync('reseller123', 10);

        // 1. Owner account (admin / admin123) — only inserted if absent
        try {
            db.run(`INSERT INTO resellers (username, email, password, role, status, must_change_password)
                    VALUES ('admin', 'admin@lightningpay.local', '${adminHash}', 'owner', 'active', 0)
                    ON CONFLICT(username) DO NOTHING`);
        } catch (_) {}

        // 2. Reseller account (reseller / reseller123) — only inserted if absent
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

// Keep a reference to the init promise so query() can await it
const dbInitPromise = initDb().catch(err => {
    console.error('❌ SQLite initialization error:', err.message);
    process.exit(1);
});

/**
 * Convert MySQL-style SQL / functions to SQLite equivalents.
 */
function convertSql(sql) {
    return sql
        .replace(/DATE_SUB\(NOW\(\),\s*INTERVAL\s+(\d+)\s+DAY\)/gi,    "datetime('now', '-$1 days')")
        .replace(/DATE_SUB\(NOW\(\),\s*INTERVAL\s+(\d+)\s+MINUTE\)/gi, "datetime('now', '-$1 minutes')")
        .replace(/DATE_ADD\(NOW\(\),\s*INTERVAL\s+(\d+)\s+MINUTE\)/gi, "datetime('now', '+$1 minutes')")
        .replace(/DATE_ADD\(NOW\(\),\s*INTERVAL\s+(\d+)\s+DAY\)/gi,    "datetime('now', '+$1 days')")
        .replace(/\bNOW\(\)/gi,                                         "datetime('now')")
        .replace(/datetime\("([^"]+)"\)/gi,                             "datetime('$1')")
        .replace(/\bDATE\(([^)]+)\)/gi,                                 "date($1)")
        .replace(/=\s*"([a-zA-Z0-9_-]+)"/g,                            "= '$1'")
        .replace(/!=\s*"([a-zA-Z0-9_-]+)"/g,                           "!= '$1'")
        .replace(/^INSERT IGNORE /i,                                    'INSERT OR IGNORE ');
}

function sanitizeParam(p) {
    if (p instanceof Date) return p.toISOString().slice(0, 19).replace('T', ' ');
    return p === undefined ? null : p;
}

const pool = {
    /**
     * Executes a SQL query.
     * Returns [rows, []]                         for SELECT / PRAGMA / WITH
     * Returns [{ insertId, affectedRows }, []]   for INSERT / UPDATE / DELETE
     */
    query: async (sql, params = []) => {
        // Ensure db is fully initialized before any query
        await dbInitPromise;

        const converted = convertSql(sql);
        const upper = converted.trim().toUpperCase();
        const isSelect = upper.startsWith('SELECT') ||
                         upper.startsWith('PRAGMA') ||
                         upper.startsWith('WITH');

        const flatParams = (Array.isArray(params) ? params.flat() : []).map(sanitizeParam);

        if (isSelect) {
            const rows = [];
            const stmt = db.prepare(converted);
            try {
                stmt.bind(flatParams);
                while (stmt.step()) {
                    rows.push(stmt.getAsObject());
                }
            } finally {
                stmt.free();
            }
            return [rows, []];
        } else {
            const stmt = db.prepare(converted);
            try {
                stmt.run(flatParams);
            } finally {
                stmt.free();
            }

            // Retrieve last insert ID and affected rows
            const idResult = db.exec('SELECT last_insert_rowid()');
            const insertId = idResult[0]?.values[0]?.[0] || 0;
            const affectedRows = db.getRowsModified();

            // Persist every write to disk so data survives restarts
            saveToDisk();

            return [{ insertId, affectedRows }, []];
        }
    }
};

/**
 * Graceful shutdown — save and close on process exit.
 */
const gracefulClose = () => {
    if (db) {
        saveToDisk();
        db.close();
        console.log('[db] SQLite connection closed cleanly.');
    }
};
process.once('SIGTERM', gracefulClose);
process.once('SIGINT',  gracefulClose);
process.once('exit',    gracefulClose);

module.exports = pool;
