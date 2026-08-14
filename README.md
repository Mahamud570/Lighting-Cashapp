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

## 🚀 Quick Start

### 1. Install Dependencies
```bash
npm install
```

### 2. Start the Server
```bash
npm start
# or
node server.js
```

### 3. Open in Browser
- **Reseller Dashboard:** [http://localhost:3000/reseller](http://localhost:3000/reseller)
- **Login Page:** [http://localhost:3000/login](http://localhost:3000/login)
  - **Username:** `admin`
  - **Password:** `admin123`
- **Public Payment Page:** [http://localhost:3000/pay/demo](http://localhost:3000/pay/demo)

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
