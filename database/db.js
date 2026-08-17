/**
 * SQLite adapter using the asynchronous `sqlite3` package.
 * Mimics the mysql2 promise pool API.
 * All routes use: const [rows] = await db.query(sql, params)
 *                 const [result] = await db.query(INSERT...) → result.insertId
 */
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, '../data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const dbPath = path.join(dataDir, 'lightning_pay.db');
const db = new sqlite3.Database(dbPath);

// Helper to run query as promise for migrations
function runAsync(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function(err) {
            if (err) reject(err);
            else resolve(this);
        });
    });
}

// Helper to get single row as promise
function getAsync(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
}

// Initialize database settings and schema sequentially
async function initDb() {
    try {
        // Performance and behavior settings
        await runAsync('PRAGMA journal_mode = WAL');
        await runAsync('PRAGMA foreign_keys = ON');
        await runAsync('PRAGMA synchronous = NORMAL');

        // Run schema
        const schemaPath = path.join(__dirname, 'schema.sql');
        if (fs.existsSync(schemaPath)) {
            const schema = fs.readFileSync(schemaPath, 'utf8');
            // Split by semicolon, filter out comments and empty statements
            const statements = schema
                .split(';')
                .map(s => s.trim())
                .filter(s => s.length > 0 && !s.startsWith('--'));

            for (const stmt of statements) {
                try {
                    await runAsync(stmt);
                } catch (e) {
                    // Ignore already-exists errors
                }
            }
        }

        // Auto-migrate columns
        const migrations = [
            "ALTER TABLE resellers ADD COLUMN role TEXT DEFAULT 'reseller'",
            "ALTER TABLE resellers ADD COLUMN blink_api_keys TEXT",
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
            "ALTER TABLE resellers ADD COLUMN auto_payout_percent REAL DEFAULT 100",
            "ALTER TABLE resellers ADD COLUMN telegram_bot_token TEXT",
            "ALTER TABLE resellers ADD COLUMN telegram_chat_id TEXT",
            "ALTER TABLE resellers ADD COLUMN binance_sweep_wallet_balance_enabled INTEGER DEFAULT 0"
        ];

        for (const mig of migrations) {
            try {
                await runAsync(mig);
            } catch (e) {
                // Column exists or other harmless migration error
            }
        }

        // Ensure admin user (id=1 or username='admin') has owner role
        try {
            await runAsync("UPDATE resellers SET role = 'owner' WHERE id = 1 OR username = 'admin'");
        } catch (e) {}

        // Relax old SQLite check constraint if present
        try {
            const tableInfo = await getAsync("SELECT sql FROM sqlite_master WHERE type='table' AND name='resellers'");
            if (tableInfo && tableInfo.sql && !tableInfo.sql.includes("'blink'")) {
                await runAsync('PRAGMA foreign_keys = OFF');
                await runAsync(`
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
                        binance_sweep_wallet_balance_enabled INTEGER DEFAULT 0,
                        auto_payout_enabled INTEGER DEFAULT 0,
                        auto_payout_address TEXT,
                        auto_payout_percent REAL DEFAULT 100,
                        charge_mode TEXT DEFAULT 'none',
                        charge_value REAL DEFAULT 0,
                        status TEXT DEFAULT 'active',
                        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                        telegram_bot_token TEXT,
                        telegram_chat_id TEXT
                    )
                `);
                await runAsync("INSERT OR IGNORE INTO resellers_temp SELECT * FROM resellers");
                await runAsync("DROP TABLE resellers");
            }
        } catch (migErr) {
            // Ignore migration check issues
        }

        try {
            await runAsync("ALTER TABLE resellers ADD COLUMN plain_password TEXT");
        } catch (e) {}

        try {
            await runAsync("ALTER TABLE sub_users ADD COLUMN plain_password TEXT");
        } catch (e) {}

        try {
            await runAsync("ALTER TABLE payments ADD COLUMN payer_location TEXT");
        } catch (e) {}

        await runAsync("UPDATE resellers SET plain_password = 'admin123' WHERE username = 'admin' AND (plain_password IS NULL OR plain_password = '')");

        console.log('✅ SQLite database initialized successfully.');
    } catch (err) {
        console.error('❌ SQLite initialization error:', err.message);
    }
}

// Start async initialization
initDb();

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
            const converted = convertSql(sql);
            const upper = converted.trim().toUpperCase();
            const isSelect = upper.startsWith('SELECT') || upper.startsWith('PRAGMA') || upper.startsWith('WITH');

            const flatParams = (Array.isArray(params) ? params.flat() : []).map(sanitizeParam);

            if (isSelect) {
                db.all(converted, flatParams, (err, rows) => {
                    if (err) reject(err);
                    else resolve([rows, []]);
                });
            } else {
                db.run(converted, flatParams, function(err) {
                    if (err) reject(err);
                    else resolve([{ insertId: this.lastID, affectedRows: this.changes }, []]);
                });
            }
        });
    }
};

/**
 * M-005 FIX: Close the SQLite connection on process shutdown.
 * Without this, the WAL journal file can remain locked on Windows when the
 * Node process is killed (e.g. Ctrl-C or SIGTERM from a process manager).
 */
const gracefulClose = () => {
    db.close(err => {
        if (err) console.error('[db] Error closing SQLite:', err.message);
        else console.log('[db] SQLite connection closed cleanly.');
    });
};
process.once('SIGTERM', gracefulClose);
process.once('SIGINT',  gracefulClose);
process.once('exit',    gracefulClose);

module.exports = pool;
