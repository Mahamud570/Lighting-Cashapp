require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const InvoiceChecker = require('./services/invoiceChecker');
const BackupService = require('./services/backupService');
const HealthMonitor = require('./services/healthMonitorService');
const structuredLogger = require('./services/structuredLogger');
const { logSafeError } = require('./utils/safeError');

function loadJwtSecret() {
    const configured = String(process.env.JWT_SECRET || '').trim();
    if (configured.length >= 32 && !/^replace-/i.test(configured)) return configured;
    if (configured) console.warn('[security] Ignoring a short or placeholder JWT_SECRET; configure at least 32 random characters.');
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
        return crypto.randomBytes(64).toString('hex');
    }
}

process.env.JWT_SECRET = loadJwtSecret();

const app = express();
const BUILD_ID = 'release1-v34-2026-09-03';
const server = http.createServer(app);
app.disable('x-powered-by');
server.requestTimeout = 30000;
server.headersTimeout = 15000;
server.keepAliveTimeout = 5000;
server.maxHeadersCount = 100;
const configuredOrigins = String(process.env.ALLOWED_ORIGINS || process.env.PUBLIC_BASE_URL || '')
    .split(',').map(value => value.trim().replace(/\/$/, '')).filter(Boolean);
const io = new Server(server, {
    cors: process.env.NODE_ENV === 'production'
        ? { origin: configuredOrigins.length ? configuredOrigins : false, credentials: true }
        : { origin: true, credentials: true }
});
app.set('trust proxy', process.env.TRUST_PROXY === '1' ? 1 : false);
app.set('io', io);

const { invoiceLimiter, pollLimiter, apiLimiter } = require('./middleware/rateLimiter');

app.use((req, res, next) => {
    const forwardedHost = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    const canonicalHost = forwardedHost.replace(/^www\./i, '');
    if (/^www\./i.test(forwardedHost) && /^[A-Za-z0-9.-]+(?::\d+)?$/.test(canonicalHost)) {
        return res.redirect(308, `https://${canonicalHost}${req.originalUrl}`);
    }
    const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    if (proto && proto === 'http' && req.headers.host && !req.headers.host.includes('localhost') && !req.headers.host.includes('127.0.0.1')) {
        const configuredBase = String(process.env.PUBLIC_BASE_URL || '').trim().replace(/\/$/, '');
        if (/^https:\/\/[A-Za-z0-9.-]+(?::\d+)?$/i.test(configuredBase)) return res.redirect(301, `${configuredBase}${req.originalUrl}`);
        const host = String(req.headers.host || '');
        if (/^[A-Za-z0-9.-]+(?::\d+)?$/.test(host)) return res.redirect(301, `https://${host}${req.originalUrl}`);
    }
    next();
});

app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data: blob:; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com; font-src 'self' data: https://fonts.gstatic.com https://cdnjs.cloudflare.com; connect-src 'self' ws: wss: https:");
    next();
});

app.use(express.json({ limit: '100kb', strict: true, verify: (req, res, buf) => { req.rawBody = Buffer.from(buf); } }));
app.use(express.urlencoded({ extended: true, limit: '100kb' }));
app.use(cookieParser());
app.use((req, res, next) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
    const origin = req.get('origin');
    if (!origin) return next();
    const requestOrigin = `${req.secure ? 'https' : 'http'}://${req.get('host')}`;
    const allowed = new Set([...configuredOrigins, requestOrigin]);
    if (!allowed.has(origin.replace(/\/$/, ''))) return res.status(403).json({ error: 'Cross-origin request blocked' });
    next();
});

// Protected panels are rendered only through authenticated routes below. Prevent
// direct access to the underlying static HTML files, which would otherwise leak
// dashboard and integration UI details before authentication.
app.get(['/app.html', '/owner.html', '/subuser.html', '/force-password-change.html'], (req, res) => {
    const destination = req.path === '/owner.html'
        ? '/owner'
        : req.path === '/subuser.html'
            ? '/subuser'
            : req.path === '/force-password-change.html'
                ? '/force-password-change'
                : '/reseller';
    res.redirect(302, destination);
});
app.use((req, res, next) => {
    const blocked = /^\/(?:data|database|middleware|routes|services|scripts|tests|node_modules|tmp)(?:\/|$)/i.test(req.path)
        || /^\/(?:server|app)\.js$/i.test(req.path)
        || /^\/(?:package(?:-lock)?\.json|\.env(?:\..*)?|\.gitignore|README\.md|SESSION_STATE\.md|STABILITY_REPORT\.md|deploy\.zip)$/i.test(req.path)
        || /(?:^|\/)\.(?!well-known(?:\/|$))/.test(req.path)
        || /\.(?:db|sqlite3?|sql|log|bak|old|orig|map|zip|tar|gz|7z|pem|key)$/i.test(req.path);
    if (blocked) return res.status(404).send('Not found');
    next();
});
app.get('/img/cashapp-social-card.png', (req, res) => {
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
    res.sendFile(path.join(__dirname, 'public', 'img', 'cashapp-social-card.png'));
});
app.use(express.static(path.join(__dirname, 'public'), {
    dotfiles: 'deny',
    index: false,
    etag: true,
    fallthrough: true,
    maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
    setHeaders: (res, filePath) => {
        if (/\.(?:html?)$/i.test(filePath)) res.setHeader('Cache-Control', 'no-store');
        if (/\.map$/i.test(filePath)) res.setHeader('Cache-Control', 'no-store');
    }
}));
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
app.post('/api/pay/:slug/invoice', invoiceLimiter, (req, res, next) => next(), payRouter);
app.get('/api/pay/invoice/:id/status', pollLimiter, (req, res, next) => next(), payRouter);
app.use('/', payRouter);

const auth = require('./middleware/auth');
const PayoutService = require('./services/payoutService');
const { requireRole } = auth;

app.get('/api/me', auth, (req, res) => {
    if (req.role === 'sub_user' && req.sub_user) {
        return res.json({ id: req.sub_user.id, username: req.sub_user.name, email: req.sub_user.email, role: 'sub_user', owner_preview: req.authPayload?.owner_preview === true });
    }
    res.json({ id: req.reseller.id, username: req.reseller.username, email: req.reseller.email, role: req.role || req.reseller.role || 'reseller' });
});

app.get('/health', async (req, res) => {
    try {
        await db.query('SELECT 1 AS ok');
        res.setHeader('Cache-Control', 'no-store');
        res.json({ status: 'ok', database: 'ok', build: BUILD_ID, version: process.env.APP_VERSION || '1.0.0' });
    } catch (err) {
        console.error('[health] Database check failed:', err && err.message ? err.message : err);
        res.status(503).json({ status: 'error', database: 'unavailable', build: BUILD_ID });
    }
});

function renderPanel(res, filename, assets = []) {
    try {
        let html = fs.readFileSync(path.join(__dirname, 'public', filename), 'utf8');
        for (const asset of assets) {
            if (asset.type === 'css' && !html.includes(asset.href)) {
                html = html.replace('</head>', `  <link rel="stylesheet" href="${asset.href}">\n</head>`);
            }
            if (asset.type === 'js' && !html.includes(asset.src)) {
                html = html.replace('</body>', `  <script src="${asset.src}"></script>\n</body>`);
            }
        }
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
        res.send(html);
    } catch (err) {
        console.error(`[panel] Failed to render ${filename}:`, err);
        res.status(500).send('Unable to load dashboard');
    }
}

app.get('/owner*', auth, requireRole('owner'), (req, res) => {
    renderPanel(res, 'owner.html', [
        { type: 'css', href: '/css/panel-mobile.css?v=5' },
        { type: 'css', href: '/css/design-v2.css?v=6' }
    ]);
});

app.get('/subuser*', auth, requireRole('sub_user'), (req, res) => {
    renderPanel(res, 'subuser.html', [
        { type: 'css', href: '/css/panel-mobile.css?v=5' },
        { type: 'css', href: '/css/design-v2.css?v=6' }
    ]);
});

app.get('/reseller*', auth, requireRole('reseller', 'owner'), (req, res) => {
    renderPanel(res, 'app.html', [
        { type: 'css', href: '/css/reseller-mobile.css?v=5' },
        { type: 'css', href: '/css/design-v2.css?v=6' },
        { type: 'js', src: '/js/reseller-enhancements.js?v=5' }
    ]);
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

app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof SyntaxError && 'body' in err) {
        console.warn('[http] Rejected malformed JSON request');
        return res.status(400).json({ error: 'Invalid JSON request body.' });
    }
    logSafeError('[http] Unhandled request error:', err);
    const status = err && (err.status || err.statusCode);
    res.status(Number.isInteger(status) && status >= 400 && status < 600 ? status : 500).json({ error: 'Request failed' });
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
            }
        } catch (_) {}
    });
});

const backgroundWorkersEnabled = process.env.NODE_ENV !== 'test';
const paymentPollInterval = backgroundWorkersEnabled ? setInterval(async () => {
    try {
        const [pending] = await db.query(
            `SELECT p.*, r.wallet_type, r.opennode_api_key, r.opennode_env,
                    r.lnbits_url, r.lnbits_invoice_key,
                    r.blink_api_key, r.blink_api_keys, r.blink_wallet_id,
                    r.alby_access_token
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
                    PayoutService.processAutoSettlement(payment.id, io).catch(err => logSafeError('[settlement] Polling trigger failed:', err));
                }
            } else if (newStatus === 'expired') {
                await db.query("UPDATE payments SET status = 'expired' WHERE id = ? AND status = 'pending'", [payment.id]);
                io.to(`reseller:${payment.reseller_id}`).emit('payment:update', { id: payment.id, status: 'expired' });
                io.to(`payment:${payment.id}`).emit('status', { status: 'expired' });
            }
        }

        await db.query("UPDATE payments SET status = 'expired' WHERE status = 'pending' AND expires_at <= datetime('now')");
    } catch (err) {
        console.error('[poll] Payment status sweep failed:', err && err.message ? err.message : err);
    }
}, 10000) : null;
if (paymentPollInterval) paymentPollInterval.unref();

const sweepInterval = backgroundWorkersEnabled ? setInterval(async () => {
    try { await PayoutService.checkAndSweepBalances(app.get('io')); }
    catch (err) { logSafeError('[sweep] Scheduled wallet balance check failed:', err); }
}, 60000) : null;
if (sweepInterval) sweepInterval.unref();

const settlementRetryInterval = backgroundWorkersEnabled ? setInterval(async () => {
    try { await PayoutService.processDueSettlementJobs(app.get('io')); }
    catch (err) { logSafeError('[settlement] Persistent retry worker failed:', err); }
}, 30000) : null;
if (settlementRetryInterval) settlementRetryInterval.unref();

const PORT = process.env.PORT || 3000;
const telegramBotEngine = require('./services/telegramBotEngine');

server.listen(PORT, () => {
    console.log(`\n⚡ Lightning Pay running at http://localhost:${PORT}`);
    console.log(`   Dashboard: http://localhost:${PORT}/reseller`);
    console.log(`   Login:     http://localhost:${PORT}/login\n`);
    if (backgroundWorkersEnabled) {
        try { telegramBotEngine.start(); } catch (e) { console.error('Telegram bot engine init error:', e.message); }
        BackupService.start();
        HealthMonitor.start();
    }
    structuredLogger.info('server.started', { port: Number(PORT), build: BUILD_ID });
});

const gracefulShutdown = (signal) => {
    console.log(`\n[server] ${signal} received — shutting down gracefully…`);
    clearInterval(paymentPollInterval);
    clearInterval(settlementRetryInterval);
    clearInterval(sweepInterval);
    BackupService.stop();
    HealthMonitor.stop();
    try { telegramBotEngine.stop(); } catch (_) {}
    server.close(() => {
        console.log('[server] HTTP server closed.');
        process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
