const express = require('express');
const request = require('supertest');

jest.mock('../middleware/auth', () => {
    const auth = (req, res, next) => {
        req.reseller = { id: 1, username: 'admin', role: 'owner' };
        req.role = 'owner';
        req.clientIp = '127.0.0.1';
        next();
    };
    auth.requireRole = () => (req, res, next) => next();
    return auth;
});
jest.mock('../database/db', () => ({ query: jest.fn() }));

const db = require('../database/db');
const ownerRouter = require('../routes/owner');
const app = express();
app.use(express.json());
app.use(ownerRouter);

beforeEach(() => {
    jest.clearAllMocks();
    db.query.mockImplementation(async (sql) => {
        if (/SELECT id,username,email FROM resellers/.test(sql)) return [[{ id: 9, username: 'shop', email: 'shop@example.com' }], []];
        if (/SELECT id,name,email,reseller_id FROM sub_users/.test(sql)) return [[{ id: 4, name: 'Merchant', email: 'merchant@example.com', reseller_id: 9 }], []];
        return [{ affectedRows: 1 }, []];
    });
});

test('refuses reseller deletion when typed confirmation does not match', async () => {
    const response = await request(app).delete('/api/owner/resellers/9').send({ confirmation: 'DELETE wrong' });
    expect(response.status).toBe(400);
    expect(db.query.mock.calls.some(([sql]) => /^DELETE FROM resellers/.test(sql))).toBe(false);
});

test('permanently deletes a reseller only after exact confirmation', async () => {
    const response = await request(app).delete('/api/owner/resellers/9').send({ confirmation: 'DELETE shop' });
    expect(response.status).toBe(200);
    expect(db.query.mock.calls.some(([sql, params]) => /^DELETE FROM resellers/.test(sql) && params[0] === 9)).toBe(true);
});

test('permanently deletes a sub-user only after exact confirmation', async () => {
    const response = await request(app).delete('/api/owner/sub-users/4').send({ confirmation: 'DELETE Merchant' });
    expect(response.status).toBe(200);
    expect(db.query.mock.calls.some(([sql, params]) => /^DELETE FROM sub_users/.test(sql) && params[0] === 4)).toBe(true);
});
