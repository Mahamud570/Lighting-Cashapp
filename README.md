# ⚡ Lightning Pay (Cash App & Bitcoin Lightning Reseller Platform)

A full-stack, 3-tier Bitcoin Lightning & Cash App payment gateway built with Node.js, Express, SQLite (embedded), WebSockets, and a dark glassmorphism reseller dashboard.

---

## 🌟 Key Features

- **📱 Cash App Dark Checkout:**
  - Exact Cash App dark aesthetics (`#141b26`), rounded keypad with touch feedback.
  - High-contrast Bitcoin Lightning QR codes with centered Cash App `$` badge.
  - Deep-link integration (`lightning:`, `bitcoin:?lightning=`) for 1-tap Cash App launch.

- **⚡ Multiple Lightning Wallet Integrations:**
  - **NWC / LNURL-Pay (CoinOS, Alby, WoS):** 100% free, zero API key, decentralized, instant auto-settlement directly into your wallet.
  - **OpenNode API:** Merchant gateway with instant payment callbacks.
  - **BTCPay Server:** Self-hosted Bitcoin & Lightning payment processing.

- **📊 3-Tier Reseller Dashboard:**
  - **Dashboard & Analytics:** Real-time metrics for links, clicks, paid USD, pending & expired invoices, 7-day & 30-day conversion stats.
  - **Payment Links Generator:** Custom slugs, open/fixed amounts, custom branding, logo uploads, and 8 custom themes.
  - **My Scan Code:** In-person QR codes with Cash App badges and 1-click sharing.
  - **Sub-Users & Withdrawals:** Sub-account hierarchy with custom exchange rates and payout requests.
  - **Security:** Multi-device session revocation, password update, and TOTP 2FA.
  - **CSV Export & Audit Logs:** Full event auditing and payment history download.

---

## 🚀 Local setup

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure the environment
Copy `.env.example` to `.env`. For the first run, set a unique owner username, email, and a password of at least 12 characters. No default production password is created.

### 3. Start the server
```bash
npm start
```

The configured startup file is `server.js`. `app.js` is only a compatibility shim and is not used by `npm start`; configure cPanel/Passenger to start `server.js`.

### 4. Open in Browser
- **Reseller Dashboard:** [http://localhost:3000/reseller](http://localhost:3000/reseller)
- **Login Page:** [http://localhost:3000/login](http://localhost:3000/login)
- **Public Payment Page:** [http://localhost:3000/pay/demo](http://localhost:3000/pay/demo)

Demo payment routes are disabled automatically in production unless `ALLOW_DEMO_PAYMENTS=1` is explicitly set.

---

## 📁 Project Architecture

```text
lightning-pay/
├── database/
│   ├── db.js             # SQLite database adapter (auto-initializes)
│   └── schema.sql        # Database tables and constraints
├── middleware/
│   └── auth.js           # JWT & session authentication
├── routes/
│   ├── auth.js           # Login, register, logout
│   ├── dashboard.js      # Reseller analytics & metrics
│   ├── wallet.js         # Lightning wallet setup (NWC, OpenNode, BTCPay)
│   ├── links.js          # Payment link creation & management
│   ├── pay.js            # Public checkout, invoice creation, & status polling
│   ├── payments.js       # Transaction history & CSV export
│   ├── users.js          # Sub-users & withdrawal requests
│   └── security.js       # 2FA (TOTP), password change, device sessions
├── public/
│   ├── css/              # Pure CSS glassmorphism styling
│   ├── js/               # Frontend SPA logic & client QR generator
│   ├── app.html          # Reseller Dashboard SPA (11 sub-views)
│   ├── pay.html          # Cash App Dark checkout page
│   ├── login.html        # Authentication UI
│   └── register.html     # New reseller signup
├── server.js             # Express & Socket.io server entry point
├── package.json
└── README.md
```

---

## 🔒 Security
- Bcrypt password hashing (salt rounds = 12)
- HttpOnly JWT cookies & SHA-256 session tokens
- Dynamic rate limiting & parameter sanitization
- TOTP Two-Factor Authentication
- Random public invoice-status tokens and strict account ownership checks
- Owner sub-user previews are time-limited, audited, and read-only
- Wallet credentials are masked and never returned to dashboard JavaScript

## Production checklist

1. Set `NODE_ENV=production`, a 64+ character `JWT_SECRET`, `PUBLIC_BASE_URL`, and `ALLOWED_ORIGINS`.
2. Use HTTPS and set `TRUST_PROXY=1` only when the app is behind a trusted reverse proxy.
3. Start **one Node.js process**. The embedded `sql.js` database is not suitable for multiple app workers sharing the same file.
4. Keep the `data/` directory outside public web access and include it in encrypted backups.
5. Enable owner 2FA immediately from **Owner → Security**.
6. Configure cPanel/Passenger with `server.js` as the startup file. Do not select `app.js`.
7. Run `npm test` and `npm audit --omit=dev` after dependency updates.

## Source-code protection reality

- Server-side files, secrets, databases, archives, and internal folders are blocked by both Express and Apache/LiteSpeed rules.
- Only files under `public/` are intentionally delivered to browsers. Browser HTML, CSS, and JavaScript can always be inspected and cannot be made “AI-proof.”
- Do not upload the project to a public repository. Keep hosting, Git, database backups, and cPanel accounts protected with unique passwords and 2FA.
- Obfuscation is not a security boundary. Keep valuable rules, provider credentials, settlement logic, and fraud controls on the server.
- The npm package is marked `private` and `UNLICENSED` to prevent accidental publishing or granting a permissive reuse license.
- On Linux hosting, use permissions `600` for `.env` and database files, `700` for `data/`, and restrict the application directory to the hosting account.
