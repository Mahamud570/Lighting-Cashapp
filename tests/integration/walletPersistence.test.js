jest.mock('../../database/db', () => ({ query: jest.fn() }));
jest.mock('../../middleware/auth');
jest.mock('../../services/lnbitsService');

const express = require('express');
const request = require('supertest');
const db = require('../../database/db');
const auth = require('../../middleware/auth');
const LNbitsService = require('../../services/lnbitsService');

auth.mockImplementation((req, res, next) => {
    req.reseller = { id: 7, role: 'reseller' };
    req.role = 'reseller';
    next();
});
auth.requireRole = () => (req, res, next) => next();

const walletRouter = require('../../routes/wallet');
const app = express();
app.use(express.json());
app.use('/', walletRouter);

beforeEach(() => {
    jest.clearAllMocks();
    LNbitsService.getWalletDetails.mockResolvedValue({ name: 'wallet', balance_sats: 10 });
});

test('LNbits save preserves stored keys when masked or blank values are submitted', async () => {
    const stored = {
        lnbits_url: 'https://lnbits.example.com',
        lnbits_invoice_key: 'stored-invoice-key',
        lnbits_admin_key: 'stored-admin-key'
    };
    db.query
        .mockResolvedValueOnce([[stored]])
        .mockResolvedValueOnce([{ affectedRows: 1 }])
        .mockResolvedValueOnce([[{ wallet_type: 'lnbits', ...stored }]]);

    const res = await request(app).post('/api/wallet/lnbits').send({
        url: stored.lnbits_url,
        invoice_key: '***-key',
        admin_key: ''
    });

    expect(res.status).toBe(200);
    expect(db.query.mock.calls[1][1]).toEqual([
        stored.lnbits_url,
        stored.lnbits_invoice_key,
        stored.lnbits_admin_key,
        7
    ]);
});

test('LNbits save fails when persisted values cannot be read back', async () => {
    db.query
        .mockResolvedValueOnce([[{}]])
        .mockResolvedValueOnce([{ affectedRows: 1 }])
        .mockResolvedValueOnce([[{}]]);

    const res = await request(app).post('/api/wallet/lnbits').send({
        url: 'https://lnbits.example.com',
        invoice_key: 'new-invoice-key',
        admin_key: 'new-admin-key'
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('could not be verified');
});
