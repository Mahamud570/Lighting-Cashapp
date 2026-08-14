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

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// Routes
app.use('/', require('./routes/auth'));
app.use('/', require('./routes/dashboard'));
app.use('/', require('./routes/links'));
app.use('/', require('./routes/wallet'));
app.use('/', require('./routes/payments'));
app.use('/', require('./routes/users'));
app.use('/', require('./routes/security'));
app.use('/', require('./routes/pay'));

const auth = require('./middleware/auth');

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

// Poll pending payments every 10s and broadcast updates
setInterval(async () => {
    try {
        const [pending] = await db.query(
            `SELECT p.*, r.opennode_api_key, r.opennode_env, r.wallet_type, r.btcpay_url, r.btcpay_store_id, r.btcpay_api_key
             FROM payments p LEFT JOIN resellers r ON p.reseller_id = r.id
             WHERE p.status = 'pending' AND p.expires_at > datetime('now')
             LIMIT 50`
        );

        for (const payment of pending) {
            let newStatus = null;

            if (payment.verify_url) {
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
                await db.query('UPDATE payments SET status = ?, paid_at = datetime(\'now\') WHERE id = ?', [newStatus, payment.id]);
                io.to(`reseller:${payment.reseller_id}`).emit('payment:update', { id: payment.id, status: newStatus });
                io.to(`payment:${payment.id}`).emit('status', { status: newStatus });
            }
        }

        // Also expire overdue
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
});
