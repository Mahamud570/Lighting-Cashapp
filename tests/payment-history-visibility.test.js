const express = require('express');
const request = require('supertest');

jest.mock('../middleware/auth', () => {
    const auth = (req, res, next) => {
        req.reseller = { id: 7, role: 'reseller' };
        req.role = 'reseller';
        next();
    };
    auth.requireRole = () => (req, res, next) => next();
    return auth;
});
jest.mock('../database/db', () => ({ query: jest.fn() }));

const db = require('../database/db');
const paymentsRouter = require('../routes/payments');
const app = express();
app.use(express.json());
app.use(paymentsRouter);

test('dashboard API hides expired payments older than ten minutes without deleting them', async () => {
    db.query
        .mockResolvedValueOnce([[], []])
        .mockResolvedValueOnce([[{ total: 0 }], []]);
    const response = await request(app).get('/api/payments');
    expect(response.status).toBe(200);
    const selectSql = db.query.mock.calls[0][0];
    const countSql = db.query.mock.calls[1][0];
    expect(selectSql).toContain("p.expires_at <= datetime('now', '-10 minutes')");
    expect(countSql).toContain("p.expires_at <= datetime('now', '-10 minutes')");
    expect(db.query.mock.calls.some(([sql]) => /^\s*DELETE/i.test(sql))).toBe(false);
});
