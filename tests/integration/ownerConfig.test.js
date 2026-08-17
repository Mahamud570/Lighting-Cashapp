/**
 * Integration Tests: routes/owner.js (Master Reseller Configuration)
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

test('GET /api/owner/resellers/:id: returns reseller config without password', async () => {
    db.query.mockResolvedValueOnce([[{ id: 2, username: 'reseller_bob', wallet_type: 'blink', blink_api_key: 'key123', password: 'hash' }]]);

    const res = await request(app).get('/api/owner/resellers/2');
    expect(res.status).toBe(200);
    expect(res.body.username).toBe('reseller_bob');
    expect(res.body.blink_api_key).toBe('key123');
    expect(res.body.password).toBeUndefined();
});

test('PUT /api/owner/resellers/:id/config: updates complete reseller settings (node pool, binance, bot, fees)', async () => {
    db.query
        .mockResolvedValueOnce([[{ id: 2 }]]) // Reseller exists check
        .mockResolvedValueOnce([[]])         // UPDATE resellers query
        .mockResolvedValueOnce([[]]);        // INSERT activity log

    const res = await request(app).put('/api/owner/resellers/2/config').send({
        wallet_type: 'blink',
        blink_api_key: 'new_key',
        blink_api_keys: 'key1\nkey2',
        binance_api_key: 'bin_key',
        binance_api_secret: 'bin_sec',
        binance_auto_sweep_enabled: true,
        binance_sweep_threshold_usd: 15.0,
        telegram_bot_token: 'bot123',
        telegram_chat_id: '999',
        charge_mode: 'percent',
        charge_value: 1.5
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toContain('Configuration updated for reseller #2');
});