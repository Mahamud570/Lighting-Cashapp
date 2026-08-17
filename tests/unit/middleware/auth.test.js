/**
 * Unit Tests: middleware/auth.js
 * Covers: valid JWT, missing token, S-002 regression (hardcoded secret),
 *         expired session, tampered signature, inactive account, proxy IP.
 */
jest.mock('../../../database/db');
jest.mock('jsonwebtoken');

const jwt = require('jsonwebtoken');
const db  = require('../../../database/db');
const authMiddleware = require('../../../middleware/auth');

const mockReseller = {
    id: 1, username: 'testreseller', email: 'test@example.com',
    status: 'active', wallet_type: 'lnbits',
    totp_enabled: 0, totp_secret: null
};

const buildMock = (options = {}) => {
    const { path = '/api/me', cookies = { auth_token: 'valid.jwt.token' }, headers = {} } = options;
    const req = { path, cookies, headers, ip: '127.0.0.1', socket: {} };
    const res = {
        status: jest.fn().mockReturnThis(),
        json:   jest.fn().mockReturnThis(),
        clearCookie: jest.fn(),
        redirect:    jest.fn()
    };
    const next = jest.fn();
    return { req, res, next };
};

beforeEach(() => {
    jest.clearAllMocks();
    process.env.JWT_SECRET = 'test_secret_value';
});
afterAll(() => { delete process.env.JWT_SECRET; });

test('valid JWT + active session: next() called, req.reseller attached', async () => {
    jwt.verify.mockReturnValue({ id: 1 });
    db.query
        .mockResolvedValueOnce([[{ id: 's1' }]])
        .mockResolvedValueOnce([[]])
        .mockResolvedValueOnce([[mockReseller]]);
    const { req, res, next } = buildMock();
    await authMiddleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.reseller).toMatchObject({ id: 1, username: 'testreseller' });
    expect(res.status).not.toHaveBeenCalled();
});

test('no token on /api path: 401 JSON', async () => {
    const { req, res, next } = buildMock({ cookies: {} });
    await authMiddleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Unauthorized' });
    expect(next).not.toHaveBeenCalled();
});

test('no token on HTML path: redirect to /login', async () => {
    const { req, res, next } = buildMock({ path: '/reseller', cookies: {} });
    await authMiddleware(req, res, next);
    expect(res.redirect).toHaveBeenCalledWith('/login');
    expect(next).not.toHaveBeenCalled();
});

test('S-002 regression: tampered JWT throws -> 401', async () => {
    jwt.verify.mockImplementation(() => { throw new Error('invalid signature'); });
    const { req, res, next } = buildMock();
    await authMiddleware(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid token' });
});

test('S-002: missing JWT_SECRET env var returns 500', async () => {
    delete process.env.JWT_SECRET;
    const { req, res, next } = buildMock();
    await authMiddleware(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
});

test('expired session in DB: 401 and cookie cleared', async () => {
    jwt.verify.mockReturnValue({ id: 1 });
    db.query.mockResolvedValueOnce([[]]); // empty sessions array
    const { req, res, next } = buildMock();
    await authMiddleware(req, res, next);
    expect(res.clearCookie).toHaveBeenCalledWith('auth_token');
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Session expired' });
    expect(next).not.toHaveBeenCalled();
});

test('inactive reseller: 401 and cookie cleared', async () => {
    jwt.verify.mockReturnValue({ id: 1 });
    db.query
        .mockResolvedValueOnce([[{ id: 's1' }]])
        .mockResolvedValueOnce([[]])
        .mockResolvedValueOnce([[]]); // no reseller
    const { req, res, next } = buildMock();
    await authMiddleware(req, res, next);
    expect(res.clearCookie).toHaveBeenCalledWith('auth_token');
    expect(next).not.toHaveBeenCalled();
});

test('TRUST_PROXY=1: clientIp resolved from X-Forwarded-For', async () => {
    process.env.TRUST_PROXY = '1';
    jwt.verify.mockReturnValue({ id: 1 });
    db.query
        .mockResolvedValueOnce([[{ id: 's1' }]])
        .mockResolvedValueOnce([[]])
        .mockResolvedValueOnce([[mockReseller]]);
    const { req, res, next } = buildMock({ headers: { 'x-forwarded-for': '203.0.113.42, 10.0.0.1' } });
    await authMiddleware(req, res, next);
    expect(req.clientIp).toBe('203.0.113.42');
    delete process.env.TRUST_PROXY;
});
