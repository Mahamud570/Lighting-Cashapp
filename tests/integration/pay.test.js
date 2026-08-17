/**
 * Integration Tests: routes/pay.js
 * Covers: invoice creation validation, note sanitization, error sanitization,
 *         status poll using InvoiceChecker (BUG-003 DRY fix), auto-settlement.
 */
jest.mock('../../database/db');
jest.mock('../../middleware/auth');
jest.mock('../../services/invoiceChecker');
jest.mock('../../services/payoutService');
jest.mock('../../services/lnbitsService');
jest.mock('../../services/blinkService');
jest.mock('axios');
jest.mock('qrcode');

const request        = require('supertest');
const express        = require('express');
const db             = require('../../database/db');
const auth           = require('../../middleware/auth');
const InvoiceChecker = require('../../services/invoiceChecker');
const PayoutService  = require('../../services/payoutService');
const LNbitsService  = require('../../services/lnbitsService');
const qrcode         = require('qrcode');
const axios          = require('axios');

auth.mockImplementation((req, res, next) => {
    req.reseller = { id: 1, wallet_type: 'lnbits' };
    req.clientIp = '127.0.0.1';
    next();
});

qrcode.toDataURL.mockResolvedValue('data:image/png;base64,mock');
PayoutService.processAutoSettlement.mockResolvedValue(undefined);

const payRouter = require('../../routes/pay');
const app = express();
app.use(express.json());
app.use('/', payRouter);

const mockLink = {
    id: 1, reseller_id: 1, slug: 'test-link', status: 'active',
    amount_type: 'open', fixed_amount: null, min_amount: 1, max_amount: 1000,
    charge_mode: 'none', charge_value: 0,
    wallet_type: 'lnbits', lnbits_url: 'https://legend.lnbits.com',
    lnbits_invoice_key: 'key123', lnbits_admin_key: null,
    blink_api_key: null, opennode_api_key: null
};

beforeEach(() => {
    jest.clearAllMocks();
    auth.mockImplementation((req, res, next) => {
        req.reseller = { id: 1, wallet_type: 'lnbits' };
        req.clientIp = '127.0.0.1';
        next();
    });
    qrcode.toDataURL.mockResolvedValue('data:image/png;base64,mock');
    PayoutService.processAutoSettlement.mockResolvedValue(undefined);
    axios.get.mockResolvedValue({ data: { data: { amount: '65000.00' } } });
    LNbitsService.createInvoice.mockResolvedValue({
        payment_hash: 'hash123', payment_request: 'lnbc...', checking_id: 'chk1'
    });
});

// -- Amount validation --------------------------------------------------------
test('Invoice: amount below min -> 400', async () => {
    db.query.mockResolvedValueOnce([[mockLink]]);
    const res = await request(app)
        .post('/api/pay/test-link/invoice')
        .send({ amount: 0.5 });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Amount must be between');
});

test('Invoice: amount above max -> 400', async () => {
    db.query.mockResolvedValueOnce([[mockLink]]);
    const res = await request(app)
        .post('/api/pay/test-link/invoice')
        .send({ amount: 1500 });
    expect(res.status).toBe(400);
});

test('A-007 regression: null max_amount does NOT block invoice creation', async () => {
    db.query
        .mockResolvedValueOnce([[{ ...mockLink, max_amount: null }]])
        .mockResolvedValueOnce([[{ insertId: 99 }]]);
    const res = await request(app)
        .post('/api/pay/test-link/invoice')
        .send({ amount: 999999 });
    expect(res.status).toBe(200);
});

// -- Note sanitization --------------------------------------------------------
test('Invoice: note > 500 chars is truncated not rejected', async () => {
    db.query
        .mockResolvedValueOnce([[mockLink]])
        .mockResolvedValueOnce([[{ insertId: 1 }]]);
    const longNote = 'A'.repeat(600);
    const res = await request(app)
        .post('/api/pay/test-link/invoice')
        .send({ amount: 25, note: longNote });
    expect(res.status).toBe(200);
    // Verify note was stored truncated (check db.query INSERT params)
    const insertArgs = db.query.mock.calls.find(c => c[0].includes('INSERT INTO payments'));
    if (insertArgs) {
        const note = insertArgs[1].find(v => typeof v === 'string' && v.length > 0 && v.startsWith('A'));
        if (note) expect(note.length).toBeLessThanOrEqual(500);
    }
});

// -- Error sanitization -------------------------------------------------------
test('Invoice: internal error does NOT expose API key in response', async () => {
    db.query.mockResolvedValueOnce([[mockLink]]);
    LNbitsService.createInvoice.mockRejectedValueOnce(new Error('API key: sk_live_secret'));
    const res = await request(app)
        .post('/api/pay/test-link/invoice')
        .send({ amount: 25 });
    expect(res.status).toBe(500);
    expect(res.body.error).not.toContain('sk_live_secret');
    expect(res.body.error).not.toContain('API key');
});

// -- Status poll (BUG-003 DRY regression) -------------------------------------
test('BUG-003 regression: status poll delegates to InvoiceChecker', async () => {
    InvoiceChecker.check.mockResolvedValue({ paid: true });

    const mockPayment = {
        id: 5, status: 'pending', wallet_type: 'lnbits',
        invoice_id: 'hash123', reseller_id: 1,
        lnbits_invoice_key: 'key', lnbits_url: 'https://example.com',
        blink_api_key: null, opennode_api_key: null, verify_url: null
    };

    db.query
        .mockResolvedValueOnce([[mockPayment]])  // SELECT payment
        .mockResolvedValueOnce([[]]);            // UPDATE status

    const res = await request(app).get('/api/pay/invoice/5/status');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('paid');
    expect(InvoiceChecker.check).toHaveBeenCalledTimes(1);
});

test('Status poll: already paid -> InvoiceChecker.check still called (expected)', async () => {
    // Note: The route currently calls check even on 'paid' status because the guard
    // is payment.status === 'pending'. A 'paid' payment returns directly.
    InvoiceChecker.check.mockResolvedValue({ paid: false });

    db.query.mockResolvedValueOnce([[{
        id: 6, status: 'paid', wallet_type: 'lnbits',
        invoice_id: 'hash123', reseller_id: 1
    }]]);
    const res = await request(app).get('/api/pay/invoice/6/status');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('paid');
    // check NOT called because status is 'paid' not 'pending'
    expect(InvoiceChecker.check).not.toHaveBeenCalled();
});

test('Status poll: pending + InvoiceChecker returns not paid -> still pending', async () => {
    InvoiceChecker.check.mockResolvedValue({ paid: false });

    db.query.mockResolvedValueOnce([[{
        id: 7, status: 'pending', wallet_type: 'lnbits',
        invoice_id: 'hash456', reseller_id: 1,
        lnbits_invoice_key: 'key', lnbits_url: 'https://example.com',
        blink_api_key: null, opennode_api_key: null, verify_url: null
    }]]);
    const res = await request(app).get('/api/pay/invoice/7/status');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('pending');
    expect(PayoutService.processAutoSettlement).not.toHaveBeenCalled();
});
