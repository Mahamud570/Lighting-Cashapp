const express = require('express');
const request = require('supertest');

jest.mock('../middleware/auth', () => {
    const auth = (req, res, next) => {
        req.reseller = { id: 7, username: 'reseller', role: 'reseller' };
        req.role = 'reseller';
        next();
    };
    auth.requireRole = () => (req, res, next) => next();
    return auth;
});
jest.mock('../database/db', () => ({ query: jest.fn() }));

const db = require('../database/db');
const linksRouter = require('../routes/links');
const app = express();
app.use(express.json());
app.use(linksRouter);

beforeEach(() => {
    jest.clearAllMocks();
    db.query.mockImplementation(async (sql, params) => {
        if (/SELECT id,reseller_id FROM payment_links/.test(sql)) {
            return params[0] === 12 && params[1] === 7 ? [[{ id: 12, reseller_id: 7 }], []] : [[], []];
        }
        if (/SELECT id FROM sub_users/.test(sql)) {
            return params[0] === 4 && params[1] === 7 ? [[{ id: 4 }], []] : [[], []];
        }
        if (/UPDATE payment_links SET sub_user_id/.test(sql)) return [{ affectedRows: 1 }, []];
        return [[], []];
    });
});

test('assigns a reseller-owned link to an active sub-user from the same reseller', async () => {
    const response = await request(app).put('/api/links/12/assign').send({ sub_user_id: 4 });
    expect(response.status).toBe(200);
    expect(db.query.mock.calls.some(([sql, params]) => /UPDATE payment_links SET sub_user_id/.test(sql) && params[0] === 4 && params[1] === 12)).toBe(true);
});

test('rejects assignment to a sub-user outside the reseller account', async () => {
    const response = await request(app).put('/api/links/12/assign').send({ sub_user_id: 99 });
    expect(response.status).toBe(400);
    expect(db.query.mock.calls.some(([sql]) => /UPDATE payment_links SET sub_user_id/.test(sql))).toBe(false);
});

test('does not allow a reseller to assign another reseller’s link', async () => {
    const response = await request(app).put('/api/links/13/assign').send({ sub_user_id: 4 });
    expect(response.status).toBe(404);
});
