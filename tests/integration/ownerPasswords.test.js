/**
 * Integration Tests: Master Boss Password Management
 */
jest.mock('../../database/db');
jest.mock('../../middleware/auth');

const request = require('supertest');
const express = require('express');
const db = require('../../database/db');
const auth = require('../../middleware/auth');

auth.mockImplementation((req, res, next) => {
    req.reseller = { id: 1, username: 'admin', role: 'owner' };
    req.role = 'owner';
    req.clientIp = '127.0.0.1';
    next();
});

auth.requireRole = (role) => (req, res, next) => next();

const ownerRouter = require('../../routes/owner');
const app = express();
app.use(express.json());
app.use('/', ownerRouter);

beforeEach(() => jest.clearAllMocks());

test('GET /api/owner/resellers: includes plain_password field', async () => {
    db.query.mockResolvedValueOnce([[{ id: 2, username: 'reseller1', email: 'r1@test.com', plain_password: 'secretpassword123', paid_volume_usd: 50.0 }]]);

    const res = await request(app).get('/api/owner/resellers');
    expect(res.status).toBe(200);
    expect(res.body[0].plain_password).toBe('secretpassword123');
});

test('GET /api/owner/sub-users: returns all merchant sub-users across platform with plain_password', async () => {
    db.query.mockResolvedValueOnce([[{ id: 10, name: 'Merchant A', email: 'm1@test.com', plain_password: 'merchantpass123', reseller_username: 'reseller1' }]]);

    const res = await request(app).get('/api/owner/sub-users');
    expect(res.status).toBe(200);
    expect(res.body[0].name).toBe('Merchant A');
    expect(res.body[0].plain_password).toBe('merchantpass123');
    expect(res.body[0].reseller_username).toBe('reseller1');
});

test('POST /api/owner/sub-users/:id/reset-password: updates password & plain_password for sub-user', async () => {
    db.query.mockResolvedValueOnce([[]]); // UPDATE sub_users query

    const res = await request(app).post('/api/owner/sub-users/10/reset-password').send({
        new_password: 'newmerchantpass123'
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toContain('Merchant sub-user password updated');
});