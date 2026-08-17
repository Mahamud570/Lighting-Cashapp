/**
 * Integration Tests: routes/twoFactor.js
 * Regression test for req.user -> req.reseller bug fix.
 */
jest.mock('../../database/db');
jest.mock('../../middleware/auth');
jest.mock('speakeasy');
jest.mock('qrcode');

const request = require('supertest');
const express = require('express');
const db = require('../../database/db');
const auth = require('../../middleware/auth');
const speakeasy = require('speakeasy');
const QRCode = require('qrcode');

auth.mockImplementation((req, res, next) => {
    req.reseller = { id: 1, username: 'testuser' };
    req.clientIp = '127.0.0.1';
    next();
});

QRCode.toDataURL.mockResolvedValue('data:image/png;base64,mockqr');
speakeasy.generateSecret.mockReturnValue({ base32: 'MOCKSECRET', otpauth_url: 'otpauth://...' });

const twoFactorRouter = require('../../routes/twoFactor');
const app = express();
app.use(express.json());
app.use('/', twoFactorRouter);

beforeEach(() => jest.clearAllMocks());

test('GET /api/2fa/status: returns 200 with enabled boolean (req.reseller fix)', async () => {
    db.query.mockResolvedValueOnce([[{ totp_enabled: 1 }]]);
    const res = await request(app).get('/api/2fa/status');
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
});

test('GET /api/2fa/setup: generates TOTP secret and QR code data URL', async () => {
    db.query
        .mockResolvedValueOnce([[{ username: 'testuser', email: 'test@example.com', totp_enabled: 0 }]])
        .mockResolvedValueOnce([[]]); // UPDATE totp_secret

    const res = await request(app).get('/api/2fa/setup');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.secret).toBe('MOCKSECRET');
});
