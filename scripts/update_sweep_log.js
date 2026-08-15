const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, '../data/lightning_pay.db');
const sqlite = new Database(dbPath);

sqlite.pragma('foreign_keys = OFF');

sqlite.prepare(`
    CREATE TABLE IF NOT EXISTS auto_sweeps_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        reseller_id INTEGER NOT NULL,
        payment_id INTEGER,
        sweep_type TEXT NOT NULL,
        amount_sats INTEGER NOT NULL,
        amount_usd REAL NOT NULL,
        target_destination TEXT NOT NULL,
        txid TEXT,
        preimage TEXT,
        fee_sats INTEGER DEFAULT 0,
        status TEXT DEFAULT 'pending',
        error_message TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
`).run();

sqlite.prepare(`INSERT OR IGNORE INTO auto_sweeps_new SELECT * FROM auto_sweeps`).run();
sqlite.prepare(`DROP TABLE auto_sweeps`).run();
sqlite.prepare(`ALTER TABLE auto_sweeps_new RENAME TO auto_sweeps`).run();

sqlite.prepare(`
    UPDATE auto_sweeps SET 
        status = 'held',
        error_message = 'Held in Blink Wallet: $1.00 (1,586 sats) is below Binance min deposit limit ($6.30 / 10,000 sats)'
    WHERE payment_id = 24
`).run();

sqlite.pragma('foreign_keys = ON');

console.log('✅ Auto_sweeps table migrated and record updated with clear note!');
