const express = require('express');
const request = require('supertest');

jest.mock('../middleware/auth', () => {
    const auth = (req, res, next) => {
        req.reseller = { id: 7, role: 'sub_user' };
        req.sub_user = { id: 3, reseller_id: 7 };
        req.role = 'sub_user';
        next();
    };
    auth.requireRole = (...roles) => (req, res, next) => roles.includes(req.role)
        ? next()
        : res.status(403).json({ error: 'Forbidden: Insufficient privileges' });
    return auth;
});
jest.mock('../database/db', () => ({ query: jest.fn() }));

const db = require('../database/db');
const linksRouter = require('../routes/links');
const app = express();
app.use(express.json());
app.use(linksRouter);

test('sub-users cannot edit payment links or per-link fees', async () => {
    const response = await request(app).put('/api/links/12').send({
        title: 'Unauthorized edit', brand_name: 'Cash Pay', theme: 'default',
        amount_type: 'open', min_amount: 1, max_amount: 2000,
        charge_mode: 'percent', charge_value: 10
    });
    expect(response.status).toBe(403);
    expect(db.query).not.toHaveBeenCalled();
});
