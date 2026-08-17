require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');
const axios = require('axios'); // top-level (A-005 fix)
const InvoiceChecker = require('./services/invoiceChecker'); // DRY fix BUG-003

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// Share io instance with Express routers
app.set('io', io);

// Rate Limiting
const { invoiceLimiter, pollLimiter, apiLimiter } = require('./middleware/rateLimiter');

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// General API rate limit (authenticated routes)
app.use('/api', apiLimiter);

// Routes
app.use('/', require('./routes/auth'));
app.use('/', require('./routes/dashboard'));
app.use('/', require('./routes/links'));
app.use('/', require('./routes/wallet'));
app.use('/', require('./routes/payments'));
app.use('/', require('./routes/users'));
app.use('/', require('./routes/security'));
app.use('/', require('./routes/sweeps'));
app.use('/', require('./routes/webhooks'));
app.use('/', require('./routes/twoFactor'));
app.use('/', require('./routes/analytics'));
app.use('/', require('./routes/owner'));

// Rate-limited public pay routes
const payRouter = require('./routes/pay');
app.post('/api/pay/invoice', invoiceLimiter, (req, res, next) => next(), payRouter);
app.get('/api/pay/invoice/:id/status', pollLimiter, (req, res, next) => next(), payRouter);
app.use('/', payRouter);

const auth = require('./middleware/auth');
const PayoutService = require('./services/payoutService');

const { requireRole } = auth;

// GET /api/me - current user info
app.get('/api/me', auth, (req, res) => {
    res.json({
        id: req.reseller.id,
        username: req.reseller.username,
        email: req.reseller.email,
        role: req.role || req.reseller.role || 'reseller'
    });
});

// Boss / Master Panel SPA
app.get('/owner*', auth, requireRole('owner'), (req, res) => {
    res.sendFile('owner.html', { root: './public' });
});

// Merchant / Sub-User Panel SPA
app.get('/subuser*', auth, (req, res) => {
    res.sendFile('subuser.html', { root: './public' });
});

// Reseller Dashboard SPA
app.get('/reseller*', auth, (req, res) => {
    res.sendFile('app.html', { root: './public' });
});

// Root redirect based on role (or fallback to /login)
app.get('/', (req, res) => {
    if (req.cookies?.auth_token) return res.redirect('/reseller');
    res.redirect('/login');
});

// 404
app.use((req, res) => {
    res.status(404).sendFile('404.html', { root: './public' });
});

// Socket.io - real-time payment updates
const db = require('./database/db');
io.on('connection', (socket) => {
    socket.on('subscribe:reseller', (resellerId) => {
        socket.join(`reseller:${resellerId}`);
    });
    socket.on('subscribe:payment', (paymentId) => {
        socket.join(`payment:${paymentId}`);
    });
});

// ─── Poll pending payments every 10 s ────────────────────────────────────────
// Uses InvoiceChecker (shared with routes/pay.js) — DRY fix BUG-003.
const paymentPollInterval = setInterval(async () => {
    try {
        const [pending] = await db.query(
            `SELECT p.*,
                    r.wallet_type, r.opennode_api_key, r.opennode_env,
                    r.lnbits_url, r.lnbits_invoice_key,
                    r.blink_api_key, r.blink_api_keys, r.blink_wallet_id,
                    r.verify_url
             FROM payments p
             LEFT JOIN resellers r ON p.reseller_id = r.id
             WHERE p.status = 'pending' AND p.expires_at > datetime('now')
             LIMIT 50`
        );

        for (const payment of pending) {
            // Delegate to InvoiceChecker — single source of truth
            const { paid, expired } = await InvoiceChecker.check(payment);
            const newStatus = paid ? 'paid' : (expired ? 'expired' : null);

            if (newStatus) {
                await db.query(
                    "UPDATE payments SET status = ?, paid_at = datetime('now') WHERE id = ?",
                    [newStatus, payment.id]
                );
                io.to(`reseller:${payment.reseller_id}`).emit('payment:update', { id: payment.id, status: newStatus });
                io.to(`payment:${payment.id}`).emit('status', { status: newStatus });

                if (newStatus === 'paid') {
                    PayoutService.processAutoSettlement(payment.id, io).catch(err => {
                        console.error('Auto settlement trigger failed in polling loop:', err);
                    });
                }
            }
        }

        // Expire overdue invoices
        await db.query("UPDATE payments SET status = 'expired' WHERE status = 'pending' AND expires_at <= datetime('now')");
    } catch (err) {
        // Silent — individual payment failures should not crash the poll loop
    }
}, 10000);

// ─── Balance sweep every 60 s ────────────────────────────────────────────────
const sweepInterval = setInterval(async () => {
    try {
        await PayoutService.checkAndSweepBalances(app.get('io'));
    } catch (err) {
        console.error('Error in scheduled wallet balance auto-sweep:', err);
    }
}, 60000);

const PORT = process.env.PORT || 3000;
const telegramBotEngine = require('./services/telegramBotEngine');

server.listen(PORT, () => {
    console.log(`\n⚡ Lightning Pay running at http://localhost:${PORT}`);
    console.log(`   Dashboard: http://localhost:${PORT}/reseller`);
    console.log(`   Login:     http://localhost:${PORT}/login\n`);

    // Start Interactive Telegram Bot Engine
    try {
        telegramBotEngine.start();
    } catch (e) {
        console.error('Telegram bot engine init error:', e.message);
    }
});

// ─── Graceful shutdown — M-001, M-002 fix ────────────────────────────────────
// Clears both setInterval loops and stops the Telegram bot before process exit
// to prevent resource leaks and WAL journal lock on Windows.
const gracefulShutdown = (signal) => {
    console.log(`\n[server] ${signal} received — shutting down gracefully…`);
    clearInterval(paymentPollInterval);
    clearInterval(sweepInterval);
    try { telegramBotEngine.stop(); } catch (_) {}
    server.close(() => {
        console.log('[server] HTTP server closed.');
        process.exit(0);
    });
    // Force-exit after 10 s if server.close() stalls
    setTimeout(() => process.exit(1), 10000).unref();
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
