-- Lightning Pay SQLite Schema
-- Auto-executed by db.js on first startup — no manual setup needed!

CREATE TABLE IF NOT EXISTS resellers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    totp_secret TEXT,
    totp_enabled INTEGER DEFAULT 0,
    wallet_type TEXT CHECK(wallet_type IN ('email','opennode','btcpay','lnbits','blink','alby')),
    wallet_email TEXT,
    opennode_api_key TEXT,
    opennode_env TEXT DEFAULT 'live',
    btcpay_url TEXT,
    btcpay_store_id TEXT,
    btcpay_api_key TEXT,
    btcpay_webhook_id TEXT,
    btcpay_webhook_secret TEXT,
    -- LNbits Credentials
    lnbits_url TEXT,
    lnbits_invoice_key TEXT,
    lnbits_admin_key TEXT,
    -- Role: owner (Master Boss) or reseller
    role TEXT DEFAULT 'reseller' CHECK(role IN ('owner','reseller')),
    -- Blink Credentials & Multi-Key Pool
    blink_api_key TEXT,
    blink_api_keys TEXT, -- JSON array of Blink API keys for rotation/limit bypass
    blink_wallet_id TEXT,
    -- Alby / NWC Credentials
    alby_nwc_string TEXT,
    alby_access_token TEXT,
    alby_webhook_secret TEXT,
    -- Binance Auto-Sweep Config
    binance_api_key TEXT,
    binance_api_secret TEXT,
    binance_auto_sweep_enabled INTEGER DEFAULT 0,
    binance_sweep_threshold_usd REAL DEFAULT 0,
    binance_sweep_type TEXT DEFAULT 'lightning' CHECK(binance_sweep_type IN ('lightning','onchain')),
    binance_sweep_wallet_balance_enabled INTEGER DEFAULT 0,
    -- Instant LN Payout Config
    auto_payout_enabled INTEGER DEFAULT 0,
    auto_payout_address TEXT,
    auto_payout_percent REAL DEFAULT 100,
    charge_mode TEXT DEFAULT 'none' CHECK(charge_mode IN ('none','fixed','percent')),
    charge_value REAL DEFAULT 0,
    status TEXT DEFAULT 'active' CHECK(status IN ('active','suspended')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sub_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reseller_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    rate_per_dollar REAL DEFAULT 1.0,
    charge_mode TEXT DEFAULT 'inherit' CHECK(charge_mode IN ('inherit','none','fixed','percent')),
    charge_value REAL DEFAULT 0,
    status TEXT DEFAULT 'active' CHECK(status IN ('active','suspended')),
    balance_usd REAL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (reseller_id) REFERENCES resellers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS payment_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reseller_id INTEGER NOT NULL,
    sub_user_id INTEGER,
    slug TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    brand_name TEXT DEFAULT 'Cash Pay',
    logo_path TEXT,
    domain TEXT DEFAULT 'portal-cash-app.com',
    theme TEXT DEFAULT 'default',
    amount_type TEXT DEFAULT 'open' CHECK(amount_type IN ('fixed','open')),
    fixed_amount REAL,
    min_amount REAL DEFAULT 1,
    max_amount REAL DEFAULT 2000,
    charge_mode TEXT DEFAULT 'inherit' CHECK(charge_mode IN ('inherit','none','fixed','percent')),
    charge_value REAL DEFAULT 0,
    preview_mode TEXT DEFAULT 'full' CHECK(preview_mode IN ('full','imessage_compact')),
    status TEXT DEFAULT 'active' CHECK(status IN ('active','inactive')),
    is_scan_code INTEGER DEFAULT 0,
    clicks INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (reseller_id) REFERENCES resellers(id) ON DELETE CASCADE,
    FOREIGN KEY (sub_user_id) REFERENCES sub_users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS link_clicks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    link_id INTEGER NOT NULL,
    ip TEXT,
    device TEXT,
    browser TEXT,
    country TEXT,
    city TEXT,
    clicked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (link_id) REFERENCES payment_links(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    link_id INTEGER NOT NULL,
    reseller_id INTEGER NOT NULL,
    sub_user_id INTEGER,
    invoice_id TEXT UNIQUE,
    public_status_token TEXT UNIQUE,
    provider TEXT DEFAULT 'email',
    amount_usd REAL NOT NULL,
    charge_usd REAL DEFAULT 0,
    total_usd REAL NOT NULL,
    amount_sats INTEGER,
    btc_amount REAL,
    lightning_invoice TEXT,
    payment_request TEXT,
    verify_url TEXT,
    payer_ip TEXT,
    payer_location TEXT,
    payer_note TEXT,
    receiving_wallet TEXT,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending','paid','failed','expired')),
    paid_at DATETIME,
    expires_at DATETIME,
    seller_checked INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (link_id) REFERENCES payment_links(id) ON DELETE CASCADE,
    FOREIGN KEY (reseller_id) REFERENCES resellers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reseller_id INTEGER NOT NULL,
    token_hash TEXT NOT NULL,
    ip TEXT,
    user_agent TEXT,
    device_type TEXT,
    is_trusted INTEGER DEFAULT 0,
    last_active DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (reseller_id) REFERENCES resellers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS activities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reseller_id INTEGER NOT NULL,
    sub_user_id INTEGER,
    actor TEXT NOT NULL,
    event TEXT NOT NULL,
    description TEXT,
    ip TEXT,
    device TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (reseller_id) REFERENCES resellers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS withdrawals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reseller_id INTEGER NOT NULL,
    sub_user_id INTEGER NOT NULL,
    amount_usd REAL NOT NULL,
    rate REAL DEFAULT 1,
    payout_amount REAL NOT NULL,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
    note TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (reseller_id) REFERENCES resellers(id) ON DELETE CASCADE,
    FOREIGN KEY (sub_user_id) REFERENCES sub_users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS payment_themes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reseller_id INTEGER,
    name TEXT NOT NULL,
    key_name TEXT NOT NULL,
    accent_color TEXT DEFAULT '#00d632',
    bg_color TEXT DEFAULT '#0d1117',
    is_global INTEGER DEFAULT 0,
    FOREIGN KEY (reseller_id) REFERENCES resellers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS auto_sweeps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reseller_id INTEGER NOT NULL,
    payment_id INTEGER,
    sweep_type TEXT NOT NULL CHECK(sweep_type IN ('binance_lightning','binance_onchain','instant_ln_payout')),
    amount_sats INTEGER NOT NULL,
    amount_usd REAL NOT NULL,
    target_destination TEXT NOT NULL,
    txid TEXT,
    preimage TEXT,
    fee_sats INTEGER DEFAULT 0,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending','completed','failed','held')),
    error_message TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (reseller_id) REFERENCES resellers(id) ON DELETE CASCADE,
    FOREIGN KEY (payment_id) REFERENCES payments(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS settlement_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    payment_id INTEGER NOT NULL,
    reseller_id INTEGER NOT NULL,
    operation_key VARCHAR(64) NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','completed','retry','failed_permanent','held','unknown')),
    amount_sats INTEGER NOT NULL DEFAULT 0,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    next_retry_at DATETIME,
    external_reference TEXT,
    last_error TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(payment_id, operation_key),
    FOREIGN KEY (payment_id) REFERENCES payments(id) ON DELETE CASCADE,
    FOREIGN KEY (reseller_id) REFERENCES resellers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS platform_wallet_fees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_sweep_id INTEGER NOT NULL UNIQUE,
    reseller_id INTEGER NOT NULL,
    amount_sats INTEGER NOT NULL,
    amount_usd REAL NOT NULL DEFAULT 0.75,
    destination TEXT NOT NULL,
    txid TEXT,
    preimage TEXT,
    network_fee_sats INTEGER DEFAULT 0,
    status VARCHAR(32) NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','completed','retry','failed_permanent','unknown')),
    attempt_count INTEGER NOT NULL DEFAULT 0,
    next_retry_at DATETIME,
    error_message TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (source_sweep_id) REFERENCES auto_sweeps(id) ON DELETE CASCADE,
    FOREIGN KEY (reseller_id) REFERENCES resellers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS wallet_sweep_locks (
    reseller_id INTEGER PRIMARY KEY,
    locked_until DATETIME NOT NULL,
    failure_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (reseller_id) REFERENCES resellers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS telegram_payment_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    payment_id INTEGER NOT NULL UNIQUE,
    reseller_id INTEGER NOT NULL,
    chat_id VARCHAR(64) NOT NULL,
    message_id INTEGER NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'received',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (payment_id) REFERENCES payments(id) ON DELETE CASCADE,
    FOREIGN KEY (reseller_id) REFERENCES resellers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS webhook_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reseller_id INTEGER,
    gateway TEXT NOT NULL,
    event_id TEXT,
    event_type TEXT,
    payload TEXT,
    processed INTEGER DEFAULT 0,
    status TEXT DEFAULT 'received',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS platform_settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_by INTEGER,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO platform_settings (key, value) VALUES
('wallet_fee_enabled', '0'),
('wallet_fee_threshold_usd', '200'),
('wallet_fee_amount_usd', '0.75'),
('wallet_fee_lightning_address', ''),
('lnbits_expiry_date', ''),
('vps_expiry_date', '2026-09-20'),
('hosting_expiry_date', '2026-09-16'),
('domain_expiry_date', '2026-09-16');

-- Default themes
INSERT OR IGNORE INTO payment_themes (id, name, key_name, accent_color, bg_color, is_global) VALUES
(1, 'Default', 'default', '#00d632', '#0d1117', 1),
(2, 'Payin Cash', 'payin_cash', '#00d830', '#0d1117', 1),
(3, 'Pay Cash App', 'pay_cash_app', '#00d64b', '#111827', 1),
(4, 'CashApp Dark', 'cashapp_dark', '#009e2f', '#000000', 1),
(5, 'CashApp Online', 'cashapp_online', '#00d632', '#1a1a2e', 1),
(6, 'Pay Isla', 'pay_isla', '#00d632', '#0f0f1a', 1),
(7, 'Beauty Queen', 'beauty_queen', '#ff6eb4', '#1a0a1a', 1),
(8, 'Beauty Queen V2', 'beauty_queen_v2', '#e040fb', '#12001a', 1);
