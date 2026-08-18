require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const axios = require('axios');
const InvoiceChecker = require('./services/invoiceChecker');

// cPanel/Passenger does not always inherit .env values. Keep an explicit
// JWT_SECRET if one is configured, otherwise create a persistent local secret
// so a missing environment variable cannot crash the entire Node application.
// The generated secret is stored outside version control and survives restarts.
function loadJwtSecret() {
    if (process.env.JWT_SECRET && process.env.JWT_SECRET.trim()) {
        return process.env.JWT_SECRET.trim();
    }

    const dataDir = path.join(__dirname, 'data');
    const secretFile = path.join(dataDir, '.jwt-secret');

    try {
        if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
        if (fs.existsSync(secretFile)) {
            const existing = fs.readFileSync(secretFile, 'utf8').trim();
            if (existing.length >= 32) {
                console.warn('[security] JWT_SECRET is not configured in the environment; using persistent local secret. Configure JWT_SECRET in cPanel for best practice.');
                return existing;
            }
        }

        const generated = crypto.randomBytes(64).toString('hex');
        fs.writeFileSync(secretFile, generated, { encoding: 'utf8', mode: 0o600 });
        console.warn('[security] JWT_SECRET was missing. Generated a persistent local secret at data/.jwt-secret. Configure JWT_SECRET in cPanel to replace it with a managed secret.');
        return generated;
    } catch (err) {
        console.error('[security] Unable to create a persistent JWT secret:', err.message);
        // Last-resort process-local secret prevents an immediate cPanel 503.
        // Sessions/tokens will invalidate after a process restart in this rare case.
        return crypto.randomBytes(64).toString('hex');
    }
}

process.env.JWT_SECRET = loadJwtSecret();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
app.set('trust proxy', 1);
app.set('io', io);

const { invoiceLimiter, pollLimiter, apiLimiter } = require('./middleware/rateLimiter');

app.use((req, res, next) => {
    const proto = req.headers['x-forwarded-proto'];
    if (proto && proto === 'http' && req.headers.host && !req.headers.host.includes('localhost') && !req.headers.host.includes('127.0.0.1')) {
        return res.redirect(301, `https://${req.headers.host}${req.url}`);
    }
    next();
});

app.use(express.json({
    verify: (req, res, buf) => {
        req.rawBody = Buffer.from(buf);
    }
}));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', apiLimiter);

app.use('/', require('./routes/auth'));
app.use('/', require('./routes/dashboard'));
app.use('/', require('./routes/links'));
app.use('/', require('./routes/wallet'));
app.use('/', require('./routes/payments'));
app.use('/', require('./routes/users'));
app.use('/', require('./routes/security'));
app.use('/', require('./routes/sweeps'));
app.use('/', require('./routes/webhooks'));
app.use('/', require('./routes/analytics'));
app.use('/', require('./routes/owner'));
app.use('/', require('./routes/subuser'));

const payRouter = require('./routes/pay');
app.post('/api/pay/invoice', invoiceLimiter, (req, res, next) => next(), payRouter);
app.get('/api/pay/invoice/:id/status', pollLimiter, (req, res, next) => next(), payRouter);
app.use('/', payRouter);

const auth = require('./middleware/auth');
const PayoutService = require('./services/payoutService');
const { requireRole } = auth;

// GET /api/me - current authenticated identity. Never expose the reseller ID to a sub-user.
app.get('/api/me', auth, (req, res) => {
    if (req.role === 'sub_user' && req.sub_user) {
        return res.json({
            id: req.sub_user.id,
            username: req.sub_user.name,
            email: req.sub_user.email,
            role: 'sub_user'
        });
    }

    res.json({
        id: req.reseller.id,
        username: req.reseller.username,
        email: req.reseller.email,
        role: req.role || req.reseller.role || 'reseller'
    });
});

app.get('/owner*', auth, requireRole('owner'), (req, res) => {
    res.sendFile('owner.html', { root: path.join(__dirname, 'public') });
});

app.get('/subuser*', auth, requireRole('sub_user'), (req, res) => {
    res.sendFile('subuser.html', { root: path.join(__dirname, 'public') });
});

app.get('/reseller*', auth, requireRole('reseller', 'owner'), (req, res) => {
    res.sendFile('app.html', { root: path.join(__dirname, 'public') });
});

app.get('/force-password-change', auth, (req, res) => {
    const mustChange = req.sub_user ? req.sub_user.must_change_password : req.reseller.must_change_password;
    if (mustChange !== 1) return res.redirect('/');
    res.sendFile('force-password-change.html', { root: path.join(__dirname, 'public') });
});

app.get('/', (req, res) => {
    const token = req.cookies?.auth_token;
    if (!token) return res.redirect('/login');
    try {
        const decoded = require('jsonwebtoken').verify(token, process.env.JWT_SECRET);
        if (decoded.role === 'owner') return res.redirect('/owner');
        if (decoded.role === 'sub_user') return res.redirect('/subuser');
        return res.redirect('/reseller');
    } catch (err) {
        res.clearCookie('auth_token');
        return res.redirect('/login');
    }
});

app.use((req, res) => {
    res.status(404).sendFile('404.html', { root: path.join(__dirname, 'public') });
});

const jwt = require('jsonwebtoken');
const db = require('./database/db');

io.use((socket, next) => {
    const cookieHeader = socket.handshake.headers?.cookie || '';
    let token = null;
    const match = cookieHeader.match(/auth_token=([^;]+)/);
    if (match) token = match[1];
    if (!token && socket.handshake.auth?.token) token = socket.handshake.auth.token;
    if (token) {
        try { socket.user = jwt.verify(token, process.env.JWT_SECRET); } catch (_) {}
    }
    next();
});

io.on('connection', (socket) => {
    socket.on('subscribe:reseller', (resellerId) => {
        const reqId = parseInt(resellerId, 10);
        if (socket.user && (socket.user.id === reqId || socket.user.reseller_id === reqId || socket.user.role === 'owner')) {
            socket.join(`reseller:${resellerId}`);
        }
    });

    socket.on('subscribe:payment', async (data) => {
        try {
            const paymentId = typeof data === 'object' ? data.paymentId : data;
            const invoiceId = typeof data === 'object' ? (data.invoiceId || data.invoice_id) : null;
            const reqId = parseInt(paymentId, 10);
            if (isNaN(reqId) || reqId <= 0) return;

            if (socket.user) {
                if (socket.user.role === 'owner') return socket.join(`payment:${reqId}`);
                const [row] = await db.query('SELECT reseller_id, sub_user_id FROM payments WHERE id = ?', [reqId]);
                if (row.length && (row[0].reseller_id === socket.user.id || row[0].reseller_id === socket.user.reseller_id || row[0].sub_user_id === socket.user.id)) {
                    return socket.join(`payment:${reqId}`);
                }
            } else if (invoiceId) {
                const [row] = await db.query('SELECT id FROM payments WHERE id = ? AND (invoice_id = ? OR lightning_invoice = ?)', [reqId, String(invoiceId), String(invoiceId)]);
                if (row.length) return socket.join(`payment:${reqId}`);
            }
        } catch (_) {}
    });
});

const paymentPollInterval = setInterval(async () => {
    try {
        const [pending] = await db.query(
            `SELECT p.*, r.wallet_type, r.opennode_api_key, r.opennode_env,
                    r.lnbits_url, r.lnbits_invoice_key,
                    r.blink_api_key, r.blink_api_keys, r.blink_wallet_id,
                    r.verify_url
             FROM payments p
             LEFT JOIN resellers r ON p.reseller_id = r.id
             WHERE p.status = 'pending' AND p.expires_at > datetime('now')
             LIMIT 50`
        );

        for (const payment of pending) {
            const { paid, expired } = await InvoiceChecker.check(payment);
            const newStatus = paid ? 'paid' : (expired ? 'expired' : null);

            if (newStatus === 'paid') {
                const [updateResult] = await db.query(
                    "UPDATE payments SET status = 'paid', paid_at = datetime('now') WHERE id = ? AND status = 'pending'",
                    [payment.id]
                );
                if (updateResult && updateResult.affectedRows === 1) {
                    io.to(`reseller:${payment.reseller_id}`).emit('payment:update', { id: payment.id, status: 'paid' });
                    io.to(`payment:${payment.id}`).emit('status', { status: 'paid' });
                    PayoutService.processAutoSettlement(payment.id, io).catch(err => console.error('Auto settlement trigger failed in polling loop:', err));
                }
            } else if (newStatus === 'expired') {
                await db.query("UPDATE payments SET status = 'expired' WHERE id = ? AND status = 'pending'", [payment.id]);
                io.to(`reseller:${payment.reseller_id}`).emit('payment:update', { id: payment.id, status: 'expired' });
                io.to(`payment:${payment.id}`).emit('status', { status: 'expired' });
            }
        }

        await db.query("UPDATE payments SET status = 'expired' WHERE status = 'pending' AND expires_at <= datetime('now')");
    } catch (err) {}
}, 10000);

const sweepInterval = setInterval(async () => {
    try { await PayoutService.checkAndSweepBalances(app.get('io')); }
    catch (err) { console.error('Error in scheduled wallet balance auto-sweep:', err); }
}, 60000);

const PORT = process.env.PORT || 3000;
const telegramBotEngine = require('./services/telegramBotEngine');

server.listen(PORT, () => {
    console.log(`\n⚡ Lightning Pay running at http://localhost:${PORT}`);
    console.log(`   Dashboard: http://localhost:${PORT}/reseller`);
    console.log(`   Login:     http://localhost:${PORT}/login\n`);
    try { telegramBotEngine.start(); } catch (e) { console.error('Telegram bot engine init error:', e.message); }
});

const gracefulShutdown = (signal) => {
    console.log(`\n[server] ${signal} received — shutting down gracefully…`);
    clearInterval(paymentPollInterval);
    clearInterval(sweepInterval);
    try { telegramBotEngine.stop(); } catch (_) {}
    server.close(() => {
        console.log('[server] HTTP server closed.');
        process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
