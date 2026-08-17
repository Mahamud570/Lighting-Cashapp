/**
 * Unit Tests: services/payoutService.js
 * Covers: getBtcPrice (primary + fallback), resolveLightningAddress edge cases,
 *         processAutoSettlement BUG-006 (btc_amount regression).
 */
jest.mock('../../../database/db');
jest.mock('axios');

const db   = require('../../../database/db');
const axios = require('axios');
const PayoutService = require('../../../services/payoutService');

beforeEach(() => jest.clearAllMocks());

// -- getBtcPrice --------------------------------------------------------------
test('getBtcPrice: Coinbase returns valid price', async () => {
    axios.get.mockResolvedValueOnce({ data: { data: { amount: '65000.00' } } });
    const price = await PayoutService.getBtcPrice();
    expect(typeof price).toBe('number');
    expect(price).toBeGreaterThan(1000);
});

test('getBtcPrice: Coinbase error falls back to 65000 default', async () => {
    axios.get.mockRejectedValue(new Error('Coinbase API down'));
    const price = await PayoutService.getBtcPrice();
    expect(price).toBe(65000);
});

// -- resolveLightningAddress --------------------------------------------------
test('resolveLightningAddress: invalid format (no @) throws', async () => {
    await expect(PayoutService.resolveLightningAddress('invalid_address'))
        .rejects.toThrow();
});

test('resolveLightningAddress: LNURL endpoint error throws', async () => {
    // Reject with an actual Error instance so it propagates through the service
    axios.get.mockRejectedValue(new Error('HTTP 404 Not Found'));
    await expect(PayoutService.resolveLightningAddress('user@example.com'))
        .rejects.toThrow();
});

test('resolveLightningAddress: endpoint returns no pr throws', async () => {
    axios.get
        .mockResolvedValueOnce({ data: { callback: 'https://example.com/cb', minSendable: 1000, maxSendable: 100000000 } })
        .mockResolvedValueOnce({ data: {} }); // no pr field
    await expect(PayoutService.resolveLightningAddress('user@example.com', 5000))
        .rejects.toThrow();
});

test('resolveLightningAddress: valid flow returns pr string', async () => {
    axios.get
        .mockResolvedValueOnce({ data: { callback: 'https://example.com/cb', minSendable: 1000, maxSendable: 100000000 } })
        .mockResolvedValueOnce({ data: { pr: 'lnbc5000...invoice' } });
    const pr = await PayoutService.resolveLightningAddress('user@example.com', 5000);
    expect(pr).toBe('lnbc5000...invoice');
});

// -- processAutoSettlement (BUG-006 regression) -------------------------------
test('processAutoSettlement: skips payout when payoutSats <= 10', async () => {
    db.query.mockResolvedValueOnce([[{
        id: 1, amount_usd: 0.001, btc_amount: 0.0000001,
        auto_payout_enabled: 1, auto_payout_address: 'user@example.com', auto_payout_percent: 100,
        reseller_id: 1, wallet_type: 'lnbits', status: 'paid'
    }]]);
    axios.get.mockResolvedValue({ data: { data: { amount: '65000.00' } } });
    await expect(PayoutService.processAutoSettlement(1, null)).resolves.not.toThrow();
});

test('processAutoSettlement BUG-006: btc_amount is used (not USD recalc)', async () => {
    const storedBtcAmount = 0.0002;

    db.query
        .mockResolvedValueOnce([[{
            id: 2, amount_usd: 13, btc_amount: storedBtcAmount,
            auto_payout_enabled: 0,
            reseller_id: 1, wallet_type: 'lnbits', status: 'paid',
            lnbits_url: 'https://lnbits.example.com', lnbits_admin_key: null,
            blink_api_key: null, opennode_api_key: null
        }]])
        .mockResolvedValue([[]]); // subsequent db calls

    axios.get.mockResolvedValue({ data: { data: { amount: '130000.00' } } });
    await expect(PayoutService.processAutoSettlement(2, null)).resolves.not.toThrow();
});
