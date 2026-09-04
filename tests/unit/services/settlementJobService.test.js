jest.mock('../../../database/db', () => ({ query: jest.fn() }));

const db = require('../../../database/db');
const SettlementJobService = require('../../../services/settlementJobService');

beforeEach(() => jest.clearAllMocks());

test('claim proceeds only when the persistent job transition affects one row', async () => {
    db.query
        .mockResolvedValueOnce([{ affectedRows: 1 }])
        .mockResolvedValueOnce([{ affectedRows: 1 }]);
    await expect(SettlementJobService.claim({
        paymentId: 4, resellerId: 2, operationKey: 'binance_lightning', amountSats: 30000
    })).resolves.toBe(true);
    expect(db.query.mock.calls[1][0]).toContain("status IN ('pending','retry')");
});

test('a duplicate worker cannot claim an already processing job', async () => {
    db.query
        .mockResolvedValueOnce([{ affectedRows: 0 }])
        .mockResolvedValueOnce([{ affectedRows: 0 }]);
    await expect(SettlementJobService.claim({
        paymentId: 4, resellerId: 2, operationKey: 'binance_lightning', amountSats: 30000
    })).resolves.toBe(false);
});

test('lost or timed-out external response becomes unknown and is not blindly retried', async () => {
    db.query.mockResolvedValueOnce([{ affectedRows: 1 }]);
    await expect(SettlementJobService.fail(4, 'binance_lightning', new Error('socket timeout')))
        .resolves.toBe('unknown');
    expect(db.query.mock.calls[0][1][0]).toBe('unknown');
});

test('authentication failure becomes permanently failed', async () => {
    db.query.mockResolvedValueOnce([{ affectedRows: 1 }]);
    const err = new Error('Unauthorized API key');
    err.response = { status: 401, data: { message: 'Unauthorized API key' } };
    await expect(SettlementJobService.fail(4, 'binance_lightning', err))
        .resolves.toBe('failed_permanent');
    expect(db.query.mock.calls[0][1][0]).toBe('failed_permanent');
});

test('provider-declared permanent failure is never retried', async () => {
    db.query.mockResolvedValueOnce([{ affectedRows: 1 }]);
    const err = new Error('Telegram rejected notification: chat not found');
    err.status = 400;
    err.permanent = true;
    await expect(SettlementJobService.fail(4, 'telegram_payment_notification', err))
        .resolves.toBe('failed_permanent');
    expect(db.query.mock.calls[0][1][0]).toBe('failed_permanent');
    expect(db.query.mock.calls[0][0]).toContain('next_retry_at = NULL');
});

test('retry worker only returns due persistent jobs', async () => {
    db.query.mockResolvedValueOnce([[{ payment_id: 8 }, { payment_id: 11 }]]);
    await expect(SettlementJobService.duePaymentIds()).resolves.toEqual([8, 11]);
    expect(db.query.mock.calls[0][0]).toContain("status = 'retry'");
});

test('stale processing operations are quarantined as unknown after restart', async () => {
    db.query.mockResolvedValueOnce([{ affectedRows: 2 }]);
    await expect(SettlementJobService.quarantineStaleProcessing()).resolves.toBe(2);
    expect(db.query.mock.calls[0][0]).toContain("status = 'unknown'");
});
