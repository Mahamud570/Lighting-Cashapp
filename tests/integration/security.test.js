/**
 * Integration Tests: routes/security.js
 * Covers: security status, TOTP disable, password change, and trusted-browser invalidation.
 */
jest.mock('../../database/db');
jest.mock('../../middleware/auth');
jest.mock('bcryptjs');
jest.mock('speakeasy');

const request  = require('supertest');
const express  = require('express');
const db       = require('../../database/db');
const auth     = require('../../middleware/auth');
const bcrypt   = require('bcryptjs');
const speakeasy = require('speakeasy');

const mockReseller = {
    id: 1, username: 'alice', totp_enabled: 1,
    totp_secret: 'JBSWY3DPEHPK3PXP'
};

auth.mockImplementation((req, res, next) => {
    req.reseller  = mockReseller;
    req.clientIp  = '127.0.0.1';
    req.sessionId = 10;
    req.tokenHash = 'current-token';
    next();
});
auth.requireRole = () => (req, res, next) => next();

const securityRouter = require('../../routes/security');
const app = express();
app.use(express.json());
app.use('/', securityRouter);

beforeEach(() => {
    jest.clearAllMocks();
    auth.mockImplementation((req, res, next) => {
        req.reseller = mockReseller;
        req.clientIp = '127.0.0.1';
        req.sessionId = 10;
        req.tokenHash = 'current-token';
        next();
    });
});

test('GET /api/security/status: 200 with sessions, trusted browsers and activity', async () => {
    db.query
        .mockResolvedValueOnce([[{ id: 10, ip: '1.2.3.4', device_type: 'desktop' }]])
        .mockResolvedValueOnce([[{ id: 3, label: 'Chrome on Windows', ip: '1.2.3.4' }]])
        .mockResolvedValueOnce([[{ event: 'login', actor: 'alice', ip: '1.2.3.4' }]]);
    const res = await request(app).get('/api/security/status');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('devices');
    expect(res.body).toHaveProperty('trusted_browsers');
    expect(res.body).toHaveProperty('activity');
    expect(res.body.current_session_id).toBe(10);
    expect(res.body.totp_enabled).toBe(true);
});

test('GET /api/security/status: DB error -> 500 (not unhandled rejection)', async () => {
    db.query.mockRejectedValueOnce(new Error('DB down'));
    const res = await request(app).get('/api/security/status');
    expect(res.status).toBe(500);
    expect(res.body).toHaveProperty('error');
});

test('S-004: disable TOTP without current_password -> 400', async () => {
    const res = await request(app)
        .post('/api/security/totp/disable')
        .send({ code: '123456' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Current password is required');
});

test('S-004: disable TOTP with wrong current_password -> 403', async () => {
    db.query.mockResolvedValueOnce([[{ password: '$2a$12$hashed_password' }]]);
    bcrypt.compare.mockResolvedValueOnce(false);
    const res = await request(app)
        .post('/api/security/totp/disable')
        .send({ code: '123456', current_password: 'wrong_password' });
    expect(res.status).toBe(403);
    expect(res.body.error).toContain('Incorrect current password');
});

test('S-004: disable TOTP with wrong TOTP code -> 400', async () => {
    db.query.mockResolvedValueOnce([[{ password: '$2a$12$hashed_password' }]]);
    bcrypt.compare.mockResolvedValueOnce(true);
    speakeasy.totp.verify.mockReturnValue(false);
    const res = await request(app)
        .post('/api/security/totp/disable')
        .send({ code: '000000', current_password: 'correct_password' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Invalid 2FA code');
});

test('S-004: disable TOTP with correct password + valid code -> 200 and revokes saved browsers', async () => {
    db.query
        .mockResolvedValueOnce([[{ password: '$2a$12$hashed' }]])
        .mockResolvedValueOnce([{ affectedRows: 1 }])
        .mockResolvedValueOnce([{ affectedRows: 2 }])
        .mockResolvedValueOnce([{ affectedRows: 1 }]);
    bcrypt.compare.mockResolvedValueOnce(true);
    speakeasy.totp.verify.mockReturnValue(true);
    const res = await request(app)
        .post('/api/security/totp/disable')
        .send({ code: '123456', current_password: 'correct_password' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(db.query).toHaveBeenCalledWith('DELETE FROM trusted_devices WHERE reseller_id = ?', [1]);
});

test('S-008: password change without current_password -> 400', async () => {
    const res = await request(app)
        .post('/api/security/password')
        .send({ new_password: 'NewPass123!', confirm_password: 'NewPass123!' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Current password is required');
});

test('S-008: password change with new_password < 8 chars -> 400', async () => {
    const res = await request(app)
        .post('/api/security/password')
        .send({ current_password: 'OldPass1!', new_password: 'abc', confirm_password: 'abc' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('8 characters');
});

test('S-008: password change with wrong current_password -> 403', async () => {
    db.query.mockResolvedValueOnce([[{ password: '$2a$12$hashed' }]]);
    bcrypt.compare.mockResolvedValueOnce(false);
    const res = await request(app)
        .post('/api/security/password')
        .send({ current_password: 'WrongOld!', new_password: 'NewPass123!', confirm_password: 'NewPass123!' });
    expect(res.status).toBe(403);
});

test('S-008: password change with mismatched confirm -> 400', async () => {
    const res = await request(app)
        .post('/api/security/password')
        .send({ current_password: 'OldPass1!', new_password: 'NewPass123!', confirm_password: 'DifferentPass!' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('do not match');
});

test('S-008: same new and current password -> 400', async () => {
    const res = await request(app)
        .post('/api/security/password')
        .send({ current_password: 'SamePass1!', new_password: 'SamePass1!', confirm_password: 'SamePass1!' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('differ from current');
});

test('S-008: valid password change -> 200, revokes other sessions and saved browsers', async () => {
    db.query
        .mockResolvedValueOnce([[{ password: '$2a$12$hashed' }]])
        .mockResolvedValueOnce([{ affectedRows: 1 }])
        .mockResolvedValueOnce([{ affectedRows: 1 }])
        .mockResolvedValueOnce([{ affectedRows: 1 }])
        .mockResolvedValueOnce([{ affectedRows: 1 }]);
    bcrypt.compare.mockResolvedValueOnce(true);
    bcrypt.hash.mockResolvedValueOnce('$2a$12$newhash');
    const res = await request(app)
        .post('/api/security/password')
        .send({ current_password: 'OldPass1!', new_password: 'NewPass123!', confirm_password: 'NewPass123!' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(db.query).toHaveBeenCalledWith(
        'DELETE FROM sessions WHERE account_type = ? AND account_id = ? AND token_hash != ?',
        ['reseller', 1, 'current-token']
    );
    expect(db.query).toHaveBeenCalledWith('DELETE FROM trusted_devices WHERE reseller_id = ?', [1]);
});
