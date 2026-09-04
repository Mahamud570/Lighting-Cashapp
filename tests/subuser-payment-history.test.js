const express = require('express');
const request = require('supertest');

jest.mock('../database/db', () => ({ query: jest.fn() }));
jest.mock('../middleware/auth', () => {
    const auth = (req, res, next) => {
        req.role = 'sub_user';
        req.authPayload = {};
        req.sub_user = { id: 3, reseller_id: 7, name: 'Merchant', rate_per_dollar: 1 };
        req.reseller = { id: 7, role: 'sub_user' };
        next();
    };
    auth.requireRole = (...roles) => (req, res, next) => roles.includes(req.role)
        ? next()
        : res.status(403).json({ error: 'Forbidden' });
    return auth;
});

const db = require('../database/db');
const router = require('../routes/subuser');
const app = express();
app.use(express.json());
app.use(router);

beforeEach(() => jest.clearAllMocks());

test('sub-user analytics includes historical assigned-link payments and exposes base amount only', async () => {
    db.query
        .mockResolvedValueOnce([[{
            id: 12, title: 'Cash App', slug: 'baby', clicks: 140,
            invoice_count: 19, paid_count: 2, paid_volume: 100
        }]])
        .mockResolvedValueOnce([[{
            id: 91, status: 'paid', amount_usd: 50,
            created_at: '2026-08-31 12:00:00', paid_at: '2026-08-31 12:01:00',
            slug: 'baby', title: 'Cash App'
        }]]);

    const response = await request(app).get('/api/subuser/analytics');

    expect(response.status).toBe(200);
    expect(response.body.recent_payments[0]).toEqual(expect.objectContaining({ amount_usd: 50 }));
    expect(response.body.recent_payments[0]).not.toHaveProperty('charge_usd');
    expect(response.body.recent_payments[0]).not.toHaveProperty('total_usd');
    expect(db.query.mock.calls[0][0]).toContain('p.amount_usd');
    expect(db.query.mock.calls[1][0]).toContain('(p.sub_user_id = ? OR pl.sub_user_id = ?)');
    expect(db.query.mock.calls[1][1]).toEqual([7, 3, 3]);
});

test('sub-user overview calculates earnings from base amounts through assigned links', async () => {
    db.query
        .mockResolvedValueOnce([[{ total_received: 100 }]])
        .mockResolvedValueOnce([[{ reserved_amount: 20 }]])
        .mockResolvedValueOnce([[{
            total_invoices: 19, paid_invoices: 2, pending_invoices: 0,
            expired_invoices: 17, total_received: 100
        }]])
        .mockResolvedValueOnce([[{ total_clicks: 140 }]]);

    const response = await request(app).get('/api/subuser/overview');

    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({
        total_received: 100,
        available_balance: 80,
        total_invoices: 19,
        paid_invoices: 2
    }));
    expect(db.query.mock.calls[0][0]).toContain('SUM(p.amount_usd)');
    expect(db.query.mock.calls[0][1]).toEqual([7, 3, 3]);
    expect(db.query.mock.calls[2][0]).toContain('(p.sub_user_id = ? OR pl.sub_user_id = ?)');
});
