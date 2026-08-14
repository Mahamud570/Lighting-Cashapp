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
