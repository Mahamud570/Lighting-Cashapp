const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, '../data/lightning_pay.db');
const sqlite = new Database(dbPath);

sqlite.pragma('foreign_keys = OFF');

// 1. Create table without restrictive CHECK
sqlite.prepare(`
    CREATE TABLE IF NOT EXISTS resellers_new (
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

// 2. Copy data
sqlite.prepare(`
    INSERT OR REPLACE INTO resellers_new (
        id, username, email, password, totp_secret, totp_enabled,
        wallet_type, wallet_email, opennode_api_key, opennode_env,
        btcpay_url, btcpay_store_id, btcpay_api_key, btcpay_webhook_id, btcpay_webhook_secret,
        charge_mode, charge_value, status, created_at, updated_at
    )
    SELECT 
        id, username, email, password, totp_secret, totp_enabled,
        wallet_type, wallet_email, opennode_api_key, opennode_env,
        btcpay_url, btcpay_store_id, btcpay_api_key, btcpay_webhook_id, btcpay_webhook_secret,
        charge_mode, charge_value, status, created_at, updated_at
    FROM resellers
`).run();

// 3. Swap tables
sqlite.prepare(`DROP TABLE resellers`).run();
sqlite.prepare(`ALTER TABLE resellers_new RENAME TO resellers`).run();

// 4. Update Blink wallet credentials
sqlite.prepare(`
    UPDATE resellers SET 
        wallet_type = 'blink',
        blink_api_key = 'blink_rPgVncESLFjFLUo2NYnsL2ExkDjNYoKB9gzoi5cN1OEECdB8lxO5230PdwzFrF3f',
        blink_wallet_id = '9177eddf-466e-4a60-8113-d4c519406f0d'
    WHERE id = 1
`).run();

sqlite.pragma('foreign_keys = ON');

console.log('✅ Resellers table migrated and Blink wallet credentials configured successfully!');
