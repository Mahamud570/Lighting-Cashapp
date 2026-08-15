require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');

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

// Rate-limited public pay routes
const payRouter = require('./routes/pay');
app.post('/api/pay/invoice', invoiceLimiter, (req, res, next) => next(), payRouter);
app.get('/api/pay/invoice/:id/status', pollLimiter, (req, res, next) => next(), payRouter);
app.use('/', payRouter);

const auth = require('./middleware/auth');
const PayoutService = require('./services/payoutService');
const LNbitsService = require('./services/lnbitsService');
const BlinkService = require('./services/blinkService');

// GET /api/me - current user info
app.get('/api/me', auth, (req, res) => {
    res.json({ id: req.reseller.id, username: req.reseller.username, email: req.reseller.email });
});

// Dashboard SPA - all /reseller/* routes serve the app shell
app.get('/reseller*', auth, (req, res) => {
    res.sendFile('app.html', { root: './public' });
});

// Root redirect
app.get('/', (req, res) => res.redirect('/reseller'));

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

// Poll pending payments every 10s and broadcast updates + trigger auto-settlements
setInterval(async () => {
    try {
        const [pending] = await db.query(
            `SELECT p.*, r.opennode_api_key, r.opennode_env, r.wallet_type, r.btcpay_url, r.btcpay_store_id, r.btcpay_api_key,
                    r.lnbits_url, r.lnbits_invoice_key,
                    r.blink_api_key, r.blink_wallet_id
             FROM payments p LEFT JOIN resellers r ON p.reseller_id = r.id
             WHERE p.status = 'pending' AND p.expires_at > datetime('now')
             LIMIT 50`
        );

        for (const payment of pending) {
            let newStatus = null;

            if (payment.wallet_type === 'blink' && payment.blink_api_key && payment.invoice_id) {
                try {
                    const check = await BlinkService.checkInvoice({
                        apiKey: payment.blink_api_key,
                        paymentHash: payment.invoice_id
                    });
                    if (check.paid) newStatus = 'paid';
                } catch (e) {}
            } else if (payment.wallet_type === 'lnbits' && payment.lnbits_invoice_key && payment.invoice_id) {
                try {
                    const check = await LNbitsService.checkInvoice({
                        url: payment.lnbits_url,
                        invoiceKey: payment.lnbits_invoice_key,
                        paymentHash: payment.invoice_id
                    });
                    if (check.paid) newStatus = 'paid';
                } catch (e) {}
            } else if (payment.verify_url) {
                try {
                    const axios = require('axios');
                    const resp = await axios.get(payment.verify_url, { timeout: 3000 });
                    if (resp.data && (resp.data.settled === true || resp.data.status === 'PAID')) {
                        newStatus = 'paid';
                    }
                } catch(e) {}
            } else if (payment.wallet_type === 'opennode' && payment.invoice_id) {
                try {
                    const axios = require('axios');
                    const base = payment.opennode_env === 'dev' ? 'https://dev-api.opennode.com' : 'https://api.opennode.com';
                    const resp = await axios.get(`${base}/v1/charges/${payment.invoice_id}`, {
                        headers: { Authorization: payment.opennode_api_key }
                    });
                    if (resp.data.data.status === 'paid') newStatus = 'paid';
                    if (resp.data.data.status === 'expired') newStatus = 'expired';
                } catch (e) {}
            }

            if (newStatus) {
                await db.query("UPDATE payments SET status = ?, paid_at = datetime('now') WHERE id = ?", [newStatus, payment.id]);
                io.to(`reseller:${payment.reseller_id}`).emit('payment:update', { id: payment.id, status: newStatus });
                io.to(`payment:${payment.id}`).emit('status', { status: newStatus });

                if (newStatus === 'paid') {
                    PayoutService.processAutoSettlement(payment.id, io).catch(err => {
                        console.error('Auto settlement trigger failed in polling loop:', err);
                    });
                }
            }
        }

        // Expire overdue
        await db.query("UPDATE payments SET status = 'expired' WHERE status = 'pending' AND expires_at <= datetime('now')");
    } catch (err) {
        // silent
    }
}, 10000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`\n⚡ Lightning Pay running at http://localhost:${PORT}`);
    console.log(`   Dashboard: http://localhost:${PORT}/reseller`);
    console.log(`   Login:     http://localhost:${PORT}/login\n`);

    // Start Interactive Telegram Bot Engine
    try {
        const telegramBotEngine = require('./services/telegramBotEngine');
        telegramBotEngine.start();
    } catch(e) {
        console.error('Telegram bot engine init error:', e.message);
    }
});
