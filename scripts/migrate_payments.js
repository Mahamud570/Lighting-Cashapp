const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, '../data/lightning_pay.db');
const sqlite = new Database(dbPath);

sqlite.pragma('foreign_keys = OFF');

sqlite.prepare(`
    CREATE TABLE IF NOT EXISTS payments_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        link_id INTEGER NOT NULL,
        reseller_id INTEGER NOT NULL,
        sub_user_id INTEGER,
        invoice_id TEXT UNIQUE,
        provider TEXT DEFAULT 'email',
        amount_usd REAL NOT NULL,
        charge_usd REAL DEFAULT 0,
        total_usd REAL NOT NULL,
        btc_amount REAL,
        lightning_invoice TEXT,
        payment_request TEXT,
        verify_url TEXT,
        payer_ip TEXT,
        payer_note TEXT,
        receiving_wallet TEXT,
        status TEXT DEFAULT 'pending' CHECK(status IN ('pending','paid','failed','expired')),
        paid_at DATETIME,
        expires_at DATETIME,
        seller_checked INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (link_id) REFERENCES payment_links(id) ON DELETE CASCADE,
        FOREIGN KEY (reseller_id) REFERENCES resellers(id) ON DELETE CASCADE
    )
`).run();

sqlite.prepare(`INSERT OR IGNORE INTO payments_new SELECT * FROM payments`).run();
sqlite.prepare(`DROP TABLE payments`).run();
sqlite.prepare(`ALTER TABLE payments_new RENAME TO payments`).run();

sqlite.pragma('foreign_keys = ON');

console.log('✅ Payments table constraint updated successfully!');
