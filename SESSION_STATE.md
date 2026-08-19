# ⚡ Lightning Pay — Session Summary & Continuation State

**Saved Date:** 2026-08-19  
**Repository:** `https://github.com/Mahamud570/Lighting-Cashapp.git` (Branch: `main`)  
**Latest Git Commit:** `866ee84` (`fix(wallet): support masked keys when saving LNbits settings`)  
**Test Suite Status:** 16/16 Test Suites Passing, 119/119 Unit & Integration Tests Passing (100% Green).

---

## 1. 🔑 System Credentials & Default Access

| Panel | URL | Username / Email | Default Password | Role |
|---|---|---|---|---|
| **Reseller Dashboard** | `/login` or `/reseller` | `reseller` / `reseller@lightningpay.local` | `reseller123` | `reseller` |
| **Owner (Admin) Dashboard** | `/login` or `/owner` | `admin` / `admin@lightningpay.local` | `admin123` | `owner` |
| **Sub-User (Merchant) Dashboard** | `/login` or `/subuser` | Generated per merchant by reseller | Set upon creation | `sub_user` |

---

## 2. 📦 Production Deployment Packages

* **Primary Archive:** `C:\Users\User\Desktop\deploy.zip` *(Updated with all fixes & high-res branding)*
* **Backup Archive 1:** `C:\Users\User\Desktop\deploy(1).zip`
* **Backup Archive 2:** `C:\Users\User\Downloads\Compressed\deploy(5).zip`

---

## 3. 🛠️ Completed Fixes & Hardening Summary

1. **Sub-User Role Restrictions & Dashboard (`public/subuser.html`, `routes/subuser.js`):**
   - Sub-users are view/withdraw-only; link creation, wallet configurations, and rate changes are restricted exclusively to Reseller/Owner.
   - Fixed QR code canvas rendering in `public/subuser.html` (resolves *"QR unavailable"*).
   - Added instant one-click PNG download for merchant scan codes.

2. **Database Column Migration Engine (`database/db.js`):**
   - Added dynamic `ensureColumn(tableName, columnName, columnDef)` utilizing `PRAGMA table_info`.
   - Automatically injects missing columns (`verify_url`, `payer_location`, `seller_checked`, `must_change_password`, `sub_user_id`) on startup without table drops or locking issues.
   - Seed accounts use `ON CONFLICT(username) DO NOTHING` to protect changed passwords across reboots.

3. **Social Media Link Preview (`public/img/cashapp-banner.png`):**
   - High-res (1200x630) dark theme Cash App branded banner matching official typography (`"Cash App"` + `"Pay instantly, securely."`).

4. **cPanel & Passenger Boot Stability (`app.js`, `server.js`):**
   - Graceful fallback for missing `JWT_SECRET` (`.jwt-secret` generator).
   - Added `tmp/restart.txt` to trigger Phusion Passenger reload cleanly.
   - Added `const { requireRole } = auth;` to `routes/links.js`.

---

## 4. 🚀 Quick cPanel Restart Steps (When Returning)

1. Upload/Extract `C:\Users\User\Desktop\deploy.zip` in `/home/portalca/lightning-pay-production/`.
2. In **cPanel → Setup Node.js App**, click **Restart**.
3. Verify at `https://portal-cash-app.com/login`.
