/**
 * Unit Tests: services/payoutService.js
 * Covers: getBtcPrice (primary + fallback), resolveLightningAddress edge cases,
 *         processAutoSettlement BUG-006 (btc_amount regression).
 */
jest.mock('../../../database/db', () => ({ query: jest.fn() }));
jest.mock('axios');

const db   = require('../../../database/db');
const axios = require('axios');
const LNbitsService = require('../../../services/lnbitsService');
const BlinkService = require('../../../services/blinkService');
const PayoutService = require('../../../services/payoutService');

beforeEach(() => jest.clearAllMocks());

describe.each([1, 25, 50, 70, 99, 100])('settlement allocation at %i%% payout', payoutPercent => {
    test('never allocates more outgoing satoshis than were received', () => {
        const allocation = PayoutService.allocateSettlement({
            receivedSats: 100000,
            payoutEnabled: true,
            payoutPercent,
            binanceEnabled: true,
            feeReserveSats: 1000
        });

        expect(allocation.merchantPayoutSats + allocation.binanceSweepSats + allocation.feeReserveSats)
            .toBeLessThanOrEqual(100000);
        expect(allocation.binanceSweepSats)
            .toBe(99000 - allocation.merchantPayoutSats);
        expect(allocation.remainingSats).toBe(1000);
    });
});

test('70% merchant payout leaves only the remainder for Binance', () => {
    const allocation = PayoutService.allocateSettlement({
        receivedSats: 100000,
        payoutEnabled: true,
        payoutPercent: 70,
        binanceEnabled: true,
        feeReserveSats: 0
    });
    expect(allocation).toMatchObject({
        receivedSats: 100000,
        merchantPayoutSats: 70000,
        binanceSweepSats: 30000,
        remainingSats: 0
    });
});

test('operation idempotency is scoped by payment and sweep type', async () => {
    db.query
        .mockResolvedValueOnce([[]])
        .mockResolvedValueOnce([[{ id: 10 }]])
        .mockResolvedValueOnce([[]])
        .mockResolvedValueOnce([[]]);
    await expect(PayoutService.operationCompleted(5, 'instant_ln_payout')).resolves.toBe(true);
    await expect(PayoutService.operationCompleted(5, 'binance_lightning')).resolves.toBe(false);
    expect(db.query.mock.calls[1][1]).toEqual([5, 'instant_ln_payout']);
    expect(db.query.mock.calls[3][1]).toEqual([5, 'binance_lightning']);
});

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

test('getGatewayBalanceSats: returns the current LNbits spendable balance', async () => {
    jest.spyOn(LNbitsService, 'getWalletDetails').mockResolvedValueOnce({ balance_sats: 3649 });
    await expect(PayoutService.getGatewayBalanceSats({
        wallet_type: 'lnbits',
        lnbits_url: 'https://lnbits.example.com',
        lnbits_invoice_key: 'invoice-key'
    })).resolves.toBe(3649);
});

test('getGatewayBalanceSats: normalizes an invalid Blink balance to zero', async () => {
    jest.spyOn(BlinkService, 'getWalletDetails').mockResolvedValueOnce({ balance_sats: undefined });
    await expect(PayoutService.getGatewayBalanceSats({
        wallet_type: 'blink',
        blink_api_key: 'blink-key'
    })).resolves.toBe(0);
});

test('recordCompletedWalletSweep: converts a recent failed retry into one completed row', async () => {
    db.query
        .mockResolvedValueOnce([[{ id: 91 }]])
        .mockResolvedValueOnce([{ affectedRows: 1 }]);

    await PayoutService.recordCompletedWalletSweep({
        resellerId: 7,
        sweepType: 'binance_lightning',
        amountSats: 83767,
        amountUsd: 64.70,
        payment: { txid: 'paid-hash', preimage: 'preimage', fee_sats: 4 }
    });

    expect(db.query).toHaveBeenCalledTimes(2);
    expect(db.query.mock.calls[1][0]).toContain("status = 'completed'");
    expect(db.query.mock.calls[1][1]).toEqual([64.70, 'paid-hash', 'preimage', 4, 91]);
});

test('recordCompletedWalletSweep: inserts when there is no failed retry row', async () => {
    db.query
        .mockResolvedValueOnce([[]])
        .mockResolvedValueOnce([{ insertId: 92 }]);

    await PayoutService.recordCompletedWalletSweep({
        resellerId: 7,
        sweepType: 'binance_lightning',
        amountSats: 50000,
        amountUsd: 35,
        payment: { txid: 'new-hash' }
    });

    expect(db.query.mock.calls[1][0]).toContain('INSERT INTO auto_sweeps');
});

test('recordFailedWalletSweep: updates an existing recent failure instead of duplicating it', async () => {
    db.query
        .mockResolvedValueOnce([[{ id: 93 }]])
        .mockResolvedValueOnce([{ affectedRows: 1 }]);

    await PayoutService.recordFailedWalletSweep({
        resellerId: 7,
        sweepType: 'binance_lightning',
        amountSats: 72973,
        amountUsd: 56.25,
        errorMessage: 'provider temporarily unavailable'
    });

    expect(db.query).toHaveBeenCalledTimes(2);
    expect(db.query.mock.calls[1][0]).toContain('UPDATE auto_sweeps');
    expect(db.query.mock.calls[1][1]).toEqual([56.25, 'provider temporarily unavailable', 93]);
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

test('resolveLightningAddressInvoice returns a BOLT11 invoice and LUD-21 verification URL', async () => {
    axios.get
        .mockResolvedValueOnce({ data: {
            tag: 'payRequest', callback: 'https://wallet.example/lnurl/callback?tag=payRequest',
            minSendable: 1000, maxSendable: 100000000
        } })
        .mockResolvedValueOnce({ data: {
            pr: 'lnbc5000exampleinvoice', verify: 'https://wallet.example/lnurl/verify/abc'
        } });

    const result = await PayoutService.resolveLightningAddressInvoice('User@Wallet.Example', 5000);

    expect(result).toEqual({
        paymentRequest: 'lnbc5000exampleinvoice',
        verifyUrl: 'https://wallet.example/lnurl/verify/abc'
    });
    expect(axios.get).toHaveBeenNthCalledWith(2,
        'https://wallet.example/lnurl/callback?tag=payRequest&amount=5000000',
        expect.objectContaining({ timeout: 10000 })
    );
});

test('resolveLightningAddressInvoice rejects amounts outside provider limits before callback', async () => {
    axios.get.mockResolvedValueOnce({ data: {
        tag: 'payRequest', callback: 'https://wallet.example/lnurl/callback',
        minSendable: 1000, maxSendable: 1000000
    } });

    await expect(PayoutService.resolveLightningAddressInvoice('user@wallet.example', 5000))
        .rejects.toThrow('outside the wallet limit');
    expect(axios.get).toHaveBeenCalledTimes(1);
});

test('resolveLightningAddressInvoice surfaces a provider callback rejection', async () => {
    axios.get
        .mockResolvedValueOnce({ data: {
            tag: 'payRequest', callback: 'https://wallet.example/lnurl/callback',
            minSendable: 1000, maxSendable: 100000000
        } })
        .mockResolvedValueOnce({ data: { status: 'ERROR', reason: 'Temporary wallet failure' } });

    await expect(PayoutService.resolveLightningAddressInvoice('user@wallet.example', 5000))
        .rejects.toThrow('Temporary wallet failure');
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
