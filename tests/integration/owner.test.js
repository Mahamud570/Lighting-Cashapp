/**
 * Integration Tests: routes/owner.js (Master Boss Panel)
 * Tests: RBAC security (reseller denied, owner allowed), stats, generate reseller panel.
 */
jest.mock('../../database/db');
jest.mock('../../middleware/auth', () => {
    const authMiddleware = async (req, res, next) => {
        // default mock role set in tests
        req.clientIp = '127.0.0.1';
        next();
    };
    authMiddleware.requireRole = (...roles) => (req, res, next) => {
        const r = req.role || req.reseller?.role || 'reseller';
        if (!roles.includes(r)) return res.status(403).json({ error: 'Forbidden' });
        next();
    };
    return authMiddleware;
});

const request = require('supertest');
const express = require('express');
const db = require('../../database/db');
const auth = require('../../middleware/auth');
const ownerRouter = require('../../routes/owner');

const app = express();
app.use(express.json());
app.use('/', ownerRouter);

beforeEach(() => jest.clearAllMocks());

test('GET /api/owner/stats: non-owner role returns 403 Forbidden', async () => {
    // Inject reseller role
    app.use((req, res, next) => { req.role = 'reseller'; req.reseller = { id: 2, role: 'reseller' }; next(); });
    const res = await request(app).get('/api/owner/stats');
    expect(res.status).toBe(403);
});

test('GET /api/owner/stats: owner role returns 200 with stats object', async () => {
    // Override middleware to set owner
    const ownerApp = express();
    ownerApp.use(express.json());
    ownerApp.use((req, res, next) => {
        req.role = 'owner';
        req.reseller = { id: 1, username: 'admin', role: 'owner' };
        req.clientIp = '127.0.0.1';
        next();
    });
    ownerApp.use('/', ownerRouter);

    db.query
        .mockResolvedValueOnce([[{ count: 5 }]])      // resellers
        .mockResolvedValueOnce([[{ count: 12 }]])     // sub_users
        .mockResolvedValueOnce([[{ total_payments: 100, paid_count: 80, total_volume_usd: '1500.00', total_btc: 0.025 }]]) // payments
        .mockResolvedValueOnce([[{ total_links: 10 }]]); // links

    const res = await request(ownerApp).get('/api/owner/stats');
    expect(res.status).toBe(200);
    expect(res.body.resellers).toBe(5);
    expect(res.body.sub_users).toBe(12);
    expect(res.body.total_volume_usd).toBe('1500.00');
});

test('POST /api/owner/resellers: generates new reseller panel', async () => {
    const ownerApp = express();
    ownerApp.use(express.json());
    ownerApp.use((req, res, next) => {
        req.role = 'owner';
        req.reseller = { id: 1, username: 'admin', role: 'owner' };
        req.clientIp = '127.0.0.1';
        next();
    });
    ownerApp.use('/', ownerRouter);

    db.query
        .mockResolvedValueOnce([[]])                  // no existing user
        .mockResolvedValueOnce([[{ insertId: 10 }]])  // INSERT reseller
        .mockResolvedValueOnce([[]]);                 // INSERT activity

    const res = await request(ownerApp)
        .post('/api/owner/resellers')
        .send({ username: 'new_reseller_1', email: 'new@example.com', password: 'Password123!' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.reseller.username).toBe('new_reseller_1');
});
