jest.mock('../../../database/db', () => ({ query: jest.fn() }));

const db = require('../../../database/db');
const PlatformWalletFeeService = require('../../../services/platformWalletFeeService');

beforeEach(() => jest.clearAllMocks());

test('disabled Wallet Fee never creates or pays a fee', async () => {
    db.query.mockResolvedValueOnce([[{ key: 'wallet_fee_enabled', value: '0' }]]);
    const payInvoice = jest.fn();
    const result = await PlatformWalletFeeService.enqueueAndProcess(
        { sourceSweepId: 9, resellerId: 2, sweepAmountUsd: 500, btcPrice: 100000 },
        { loadReseller: jest.fn(), resolveInvoice: jest.fn(), payInvoice }
    );
    expect(result).toBe('skipped');
    expect(payInvoice).not.toHaveBeenCalled();
    expect(db.query).toHaveBeenCalledTimes(1);
});

test('eligible Wallet Fee is paid once and completed visibly', async () => {
    db.query
        .mockResolvedValueOnce([[
            { key: 'wallet_fee_enabled', value: '1' },
            { key: 'wallet_fee_threshold_usd', value: '200' },
            { key: 'wallet_fee_amount_usd', value: '0.75' },
            { key: 'wallet_fee_lightning_address', value: 'owner@example.com' }
        ]])
        .mockResolvedValueOnce([{ insertId: 1, affectedRows: 1 }])
        .mockResolvedValueOnce([[{ id: 1, source_sweep_id: 9, reseller_id: 2, amount_sats: 750, amount_usd: 0.75, destination: 'owner@example.com', status: 'pending' }]])
        .mockResolvedValueOnce([{ affectedRows: 1 }])
        .mockResolvedValueOnce([{ affectedRows: 1 }]);
    const handlers = {
        loadReseller: jest.fn().mockResolvedValue({ id: 2, wallet_type: 'lnbits' }),
        resolveInvoice: jest.fn().mockResolvedValue('bolt11'),
        payInvoice: jest.fn().mockResolvedValue({ txid: 'hash', preimage: 'preimage', fee_sats: 2 })
    };
    const result = await PlatformWalletFeeService.enqueueAndProcess(
        { sourceSweepId: 9, resellerId: 2, sweepAmountUsd: 500, btcPrice: 100000 }, handlers
    );
    expect(result).toBe('completed');
    expect(handlers.payInvoice).toHaveBeenCalledTimes(1);
    expect(db.query.mock.calls.at(-1)[0]).toContain("status='completed'");
});

test('an uncertain outbound result is never retried automatically', async () => {
    db.query.mockResolvedValueOnce([{ affectedRows: 1 }]).mockResolvedValueOnce([{ affectedRows: 1 }]);
    const timeout = Object.assign(new Error('socket timeout'), { code: 'ETIMEDOUT' });
    const result = await PlatformWalletFeeService.processRow(
        { id: 3, reseller_id: 2, amount_sats: 750, destination: 'owner@example.com', status: 'pending' },
        {
            loadReseller: jest.fn().mockResolvedValue({ id: 2 }),
            resolveInvoice: jest.fn().mockResolvedValue('bolt11'),
            payInvoice: jest.fn().mockRejectedValue(timeout)
        }
    );
    expect(result).toBe('unknown');
    expect(db.query.mock.calls[1][0]).toContain('next_retry_at=NULL');
});
