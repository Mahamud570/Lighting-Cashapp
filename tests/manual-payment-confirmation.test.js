const express = require('express');
const request = require('supertest');

jest.mock('../middleware/auth', () => {
    const auth = (req, res, next) => {
        req.reseller = { id: 7, username: 'reseller', role: 'reseller' };
        req.role = 'reseller';
        req.clientIp = '127.0.0.1';
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

beforeEach(() => {
    jest.clearAllMocks();
    db.query.mockImplementation(async sql => {
        if (/SELECT id, provider, status, total_usd/.test(sql)) {
            return [[{ id: 12, provider: 'email', status: 'pending', total_usd: 3 }], []];
        }
        if (/UPDATE payments/.test(sql)) return [{ affectedRows: 1 }, []];
        return [{ affectedRows: 1 }, []];
    });
});

test('requires explicit wallet receipt confirmation', async () => {
    const response = await request(app).patch('/api/payments/12/confirm-paid').send({ confirmed: false });
    expect(response.status).toBe(400);
    expect(db.query).not.toHaveBeenCalled();
});

test('marks a direct-address payment paid after confirmation', async () => {
    const response = await request(app).patch('/api/payments/12/confirm-paid').send({ confirmed: true });
    expect(response.status).toBe(200);
    expect(db.query.mock.calls.some(([sql, params]) => /UPDATE payments/.test(sql) && params[0] === 12 && params[1] === 7)).toBe(true);
});

test('does not allow manual confirmation for API-connected providers', async () => {
    db.query.mockImplementationOnce(async () => [[{ id: 12, provider: 'lnbits', status: 'pending', total_usd: 3 }], []]);
    const response = await request(app).patch('/api/payments/12/confirm-paid').send({ confirmed: true });
    expect(response.status).toBe(400);
    expect(db.query.mock.calls.some(([sql]) => /UPDATE payments/.test(sql))).toBe(false);
});
