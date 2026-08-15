/**
 * SQLite adapter that mimics the mysql2 promise pool API.
 * All routes use: const [rows] = await db.query(sql, params)
 *                 const [result] = await db.query(INSERT...) → result.insertId
 */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, '../data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const dbPath = path.join(dataDir, 'lightning_pay.db');
const sqlite = new Database(dbPath);

// Performance settings
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');
sqlite.pragma('synchronous = NORMAL');

// Run schema on first start
const schemaPath = path.join(__dirname, 'schema.sql');
if (fs.existsSync(schemaPath)) {
    const schema = fs.readFileSync(schemaPath, 'utf8');
    const statements = schema.split(';').map(s => s.trim()).filter(s => s.length > 0);
    for (const stmt of statements) {
        try { sqlite.prepare(stmt).run(); } catch(e) { /* ignore already-exists errors */ }
    }
}

// Auto-migrate newly added columns for existing databases
const migrations = [
    "ALTER TABLE resellers ADD COLUMN lnbits_url TEXT",
    "ALTER TABLE resellers ADD COLUMN lnbits_invoice_key TEXT",
    "ALTER TABLE resellers ADD COLUMN lnbits_admin_key TEXT",
    "ALTER TABLE resellers ADD COLUMN blink_api_key TEXT",
    "ALTER TABLE resellers ADD COLUMN blink_wallet_id TEXT",
    "ALTER TABLE resellers ADD COLUMN alby_nwc_string TEXT",
    "ALTER TABLE resellers ADD COLUMN alby_access_token TEXT",
    "ALTER TABLE resellers ADD COLUMN alby_webhook_secret TEXT",
    "ALTER TABLE resellers ADD COLUMN binance_api_key TEXT",
    "ALTER TABLE resellers ADD COLUMN binance_api_secret TEXT",
    "ALTER TABLE resellers ADD COLUMN binance_auto_sweep_enabled INTEGER DEFAULT 0",
    "ALTER TABLE resellers ADD COLUMN binance_sweep_threshold_usd REAL DEFAULT 0",
    "ALTER TABLE resellers ADD COLUMN binance_sweep_type TEXT DEFAULT 'lightning'",
    "ALTER TABLE resellers ADD COLUMN auto_payout_enabled INTEGER DEFAULT 0",
    "ALTER TABLE resellers ADD COLUMN auto_payout_address TEXT",
    "ALTER TABLE resellers ADD COLUMN auto_payout_percent REAL DEFAULT 100"
];

for (const mig of migrations) {
    try { sqlite.prepare(mig).run(); } catch (e) { /* column exists */ }
}

// Relax old SQLite check constraint if present
try {
    const tableInfo = sqlite.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='resellers'").get();
    if (tableInfo && tableInfo.sql && !tableInfo.sql.includes("'blink'")) {
        sqlite.pragma('foreign_keys = OFF');
        sqlite.prepare(`
            CREATE TABLE IF NOT EXISTS resellers_temp (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                email TEXT UNIQUE NOT NULL,
                password TEXT NOT NULL,
                totp_secret TEXT,
                totp_enabled INTEGER DEFAULT 0,
                wallet_type TEXT,
                wallet_email TEXT,
                opennode_api_key TEXT,
                opennode_env TEXT DEFAULT 'live',
                btcpay_url TEXT,
                btcpay_store_id TEXT,
                btcpay_api_key TEXT,
                btcpay_webhook_id TEXT,
                btcpay_webhook_secret TEXT,
                lnbits_url TEXT,
                lnbits_invoice_key TEXT,
                lnbits_admin_key TEXT,
                blink_api_key TEXT,
                blink_wallet_id TEXT,
                alby_nwc_string TEXT,
                alby_access_token TEXT,
                alby_webhook_secret TEXT,
                binance_api_key TEXT,
                binance_api_secret TEXT,
                binance_auto_sweep_enabled INTEGER DEFAULT 0,
                binance_sweep_threshold_usd REAL DEFAULT 0,
                binance_sweep_type TEXT DEFAULT 'lightning',
                auto_payout_enabled INTEGER DEFAULT 0,
                auto_payout_address TEXT,
                auto_payout_percent REAL DEFAULT 100,
                charge_mode TEXT DEFAULT 'none',
                charge_value REAL DEFAULT 0,
                status TEXT DEFAULT 'active',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `).run();
        sqlite.prepare("INSERT OR IGNORE INTO resellers_temp SELECT * FROM resellers").run();
        sqlite.prepare("DROP TABLE resellers").run();
        sqlite.prepare("ALTER TABLE resellers_temp RENAME TO resellers").run();
        sqlite.pragma('foreign_keys = ON');
    }
} catch(migErr) {
    // console.log('Migration check info:', migErr.message);
}

/**
 * Convert MySQL placeholders and functions to SQLite equivalents inline.
 */
function convertSql(sql) {
    return sql
        // MySQL date functions → SQLite equivalents
        .replace(/DATE_SUB\(NOW\(\),\s*INTERVAL\s+(\d+)\s+DAY\)/gi, "datetime('now', '-$1 days')")
        .replace(/DATE_SUB\(NOW\(\),\s*INTERVAL\s+(\d+)\s+MINUTE\)/gi, "datetime('now', '-$1 minutes')")
        .replace(/DATE_ADD\(NOW\(\),\s*INTERVAL\s+(\d+)\s+MINUTE\)/gi, "datetime('now', '+$1 minutes')")
        .replace(/DATE_ADD\(NOW\(\),\s*INTERVAL\s+(\d+)\s+DAY\)/gi, "datetime('now', '+$1 days')")
        .replace(/\bNOW\(\)/gi, "datetime('now')")
        .replace(/datetime\("([^"]+)"\)/gi, "datetime('$1')")
        .replace(/\bDATE\(([^)]+)\)/gi, "date($1)")
        // Convert double-quoted string literals in WHERE/VALUES to single quotes
        .replace(/=\s*"([a-zA-Z0-9_-]+)"/g, "= '$1'")
        .replace(/!=\s*"([a-zA-Z0-9_-]+)"/g, "!= '$1'")
        // MySQL IGNORE → SQLite OR IGNORE
        .replace(/^INSERT IGNORE /i, 'INSERT OR IGNORE ');
}

function sanitizeParam(p) {
    if (p instanceof Date) {
        return p.toISOString().slice(0, 19).replace('T', ' ');
    }
    return p;
}

const pool = {
    /**
     * Executes a SQL query.
     * Returns [rows, []] for SELECT (mimics mysql2 destructuring).
     * Returns [{ insertId, affectedRows }, []] for INSERT/UPDATE/DELETE.
     */
    query: (sql, params = []) => {
        return new Promise((resolve, reject) => {
            try {
                const converted = convertSql(sql);
                const upper = converted.trim().toUpperCase();
                const isSelect = upper.startsWith('SELECT') || upper.startsWith('PRAGMA') || upper.startsWith('WITH');

                const flatParams = (Array.isArray(params) ? params.flat() : []).map(sanitizeParam);

                const stmt = sqlite.prepare(converted);

                if (isSelect) {
                    const rows = stmt.all(...flatParams);
                    resolve([rows, []]);
                } else {
                    const result = stmt.run(...flatParams);
                    resolve([{ insertId: result.lastInsertRowid, affectedRows: result.changes }, []]);
                }
            } catch (err) {
                reject(err);
            }
        });
    }
};

module.exports = pool;
