const rateLimit = require('express-rate-limit');

/**
 * Rate Limiting Middleware
 * Protects public and auth endpoints from abuse / brute force
 */

// ─── Auth: Login / Register ───────────────────────────────────────────────────
// Max 10 attempts per 15 min per IP — stops brute force
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many login attempts. Please try again in 15 minutes.' },
    skipSuccessfulRequests: true  // Only count failed attempts
});

// ─── Public Invoice Creation ───────────────────────────────────────────────────
// Max 20 invoices per 10 min per IP — stops invoice spam
const invoiceLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many payment requests. Please slow down.' }
});

// ─── Invoice Status Polling ────────────────────────────────────────────────────
// Max 120 polls per min per IP — allows 2/sec polling but stops flood
const pollLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Polling too fast. Please wait.' }
});

// ─── 2FA & Security Actions ───────────────────────────────────────────────────
// Max 5 per 15 min per IP — prevents OTP bruteforce
const totpLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many 2FA attempts. Please wait 15 minutes.' }
});

// ─── API General ──────────────────────────────────────────────────────────────
// Max 200 requests per min per IP for authenticated API calls
const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Rate limit exceeded. Please slow down.' }
});

module.exports = { authLimiter, invoiceLimiter, pollLimiter, totpLimiter, apiLimiter };
