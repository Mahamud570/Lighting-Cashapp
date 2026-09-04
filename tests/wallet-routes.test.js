const express = require('express');
const request = require('supertest');

jest.mock('../middleware/auth', () => {
    const auth = (req, res, next) => {
        req.reseller = { id: 7, role: 'reseller' };
        req.role = 'reseller';
        next();
    };
    auth.requireRole = () => (req, res, next) => next();
    return auth;
});

jest.mock('../database/db', () => ({ query: jest.fn() }));
jest.mock('../services/lnbitsService', () => ({ getWalletDetails: jest.fn() }));
jest.mock('../services/blinkService', () => ({ getWalletDetails: jest.fn() }));
jest.mock('../services/albyService', () => ({ getAccountDetails: jest.fn() }));
jest.mock('../services/telegramService', () => ({ sendMessage: jest.fn() }));
jest.mock('axios');

const db = require('../database/db');
const axios = require('axios');
const LNbitsService = require('../services/lnbitsService');
const BlinkService = require('../services/blinkService');
const AlbyService = require('../services/albyService');
const walletRouter = require('../routes/wallet');

const app = express();
app.use(express.json());
app.use(walletRouter);

const current = {
    id: 7,
    wallet_type: null,
    lnbits_url: 'https://ln.example',
    lnbits_invoice_key: 'old-read',
    lnbits_admin_key: 'old-admin',
    blink_api_key: 'old-blink',
    blink_api_keys: JSON.stringify(['old-blink']),
    blink_wallet_id: 'wallet-old',
    alby_access_token: 'old-alby',
    opennode_api_key: 'old-open',
    opennode_env: 'live',
    btcpay_url: 'https://btcpay.example',
    btcpay_store_id: 'store-old',
    btcpay_api_key: 'old-btcpay',
    btcpay_webhook_secret: 'old-secret'
};

beforeEach(() => {
    jest.clearAllMocks();
    db.query.mockImplementation(async sql => {
        if (/^\s*SELECT/i.test(sql)) return [[{ ...current }], []];
        return [{ affectedRows: 1 }, []];
    });
    LNbitsService.getWalletDetails.mockResolvedValue({ name: 'Main', balance_sats: 10 });
    BlinkService.getWalletDetails.mockResolvedValue({ wallet_id: 'wallet-new', balance_sats: 20 });
    AlbyService.getAccountDetails.mockResolvedValue({ lightning_address: 'me@example.com', balance_sats: 30 });
    axios.get.mockResolvedValue({ data: { name: 'Store' } });
});

test('connects LNbits and persists verified credentials', async () => {
    db.query
        .mockResolvedValueOnce([[{ ...current }], []])
        .mockResolvedValueOnce([{ affectedRows: 1 }, []])
        .mockResolvedValueOnce([[{ wallet_type: 'lnbits', lnbits_url: 'https://ln.example', lnbits_invoice_key: 'new-read', lnbits_admin_key: 'new-admin' }], []]);
    const response = await request(app).post('/api/wallet/lnbits').send({
        url: 'https://ln.example', invoice_key: 'new-read', admin_key: 'new-admin'
    });
    expect(response.status).toBe(200);
    expect(LNbitsService.getWalletDetails).toHaveBeenCalledWith({ url: 'https://ln.example', invoiceKey: 'new-read' });
    expect(db.query.mock.calls.some(([sql]) => /wallet_type = "lnbits"/.test(sql))).toBe(true);
});

test('connects LNP/Blink and saves a normalized key pool', async () => {
    const response = await request(app).post('/api/wallet/blink').send({
        api_key: 'key-one', api_keys: 'key-one\nkey-two', wallet_id: ''
    });
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ wallet_id: 'wallet-new', key_count: 2 });
    const update = db.query.mock.calls.find(([sql]) => /wallet_type = 'blink'/.test(sql));
    expect(JSON.parse(update[1][1])).toEqual(['key-one', 'key-two']);
});

test('connects Alby and preserves a masked saved token', async () => {
    const response = await request(app).post('/api/wallet/alby').send({ access_token: '***alby', nwc_string: '' });
    expect(response.status).toBe(200);
    expect(AlbyService.getAccountDetails).toHaveBeenCalledWith({ accessToken: 'old-alby', nwcString: null });
});

test('connects OpenNode before saving it', async () => {
    const response = await request(app).post('/api/wallet/opennode').send({ api_key: 'new-open', env: 'dev' });
    expect(response.status).toBe(200);
    expect(axios.get).toHaveBeenCalledWith(
        'https://dev-api.opennode.com/v1/account/payment/summary',
        expect.objectContaining({ headers: { Authorization: 'new-open' } })
    );
});

test('connects BTCPay and preserves a masked webhook secret', async () => {
    const response = await request(app).post('/api/wallet/btcpay').send({
        url: 'https://btcpay.example/', store_id: 'store-new', api_key: 'new-key',
        webhook_id: 'hook-new', webhook_secret: '***cret'
    });
    expect(response.status).toBe(200);
    const update = db.query.mock.calls.find(([sql]) => /wallet_type = 'btcpay'/.test(sql));
    expect(update[1]).toContain('old-secret');
});

test('rejects an invalid Lightning Address', async () => {
    const response = await request(app).post('/api/wallet/email').send({ email: 'not-an-address' });
    expect(response.status).toBe(400);
});

test('tests a Lightning Address without creating an invoice', async () => {
    axios.get.mockResolvedValueOnce({
        data: {
            tag: 'payRequest',
            callback: 'https://wallet.example/lnurl/callback',
            minSendable: 1000,
            maxSendable: 100000000
        }
    });
    const response = await request(app).post('/api/wallet/email/test').send({ email: 'name@wallet.example' });
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ min_sats: 1, max_sats: 100000 });
    expect(axios.get).toHaveBeenCalledWith(
        'https://wallet.example/.well-known/lnurlp/name',
        expect.objectContaining({ maxRedirects: 3 })
    );
});
