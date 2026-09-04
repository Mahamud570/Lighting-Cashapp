jest.mock('../../../database/db', () => ({ query: jest.fn() }));
const db = require('../../../database/db');
const Payout = require('../../../services/payoutService');
const Jobs = require('../../../services/settlementJobService');

beforeEach(() => { jest.restoreAllMocks(); db.query.mockReset(); db.query.mockResolvedValue([{affectedRows:1}]); });

test('balance validation includes a network reserve and refuses stale amounts', async () => {
    jest.spyOn(Payout, 'getGatewayBalanceSats').mockResolvedValue(10000);
    expect(await Payout.validateSweepBalance({wallet_type:'blink'}, 10000)).toMatchObject({sufficient:false,reserve:1000});
    expect(await Payout.validateSweepBalance({wallet_type:'blink'}, 9000)).toMatchObject({sufficient:true});
});
test('missing admin key is rejected before an outbound invoice can be requested', async () => {
    await expect(Payout.validateSweepBalance({wallet_type:'lnbits'},10000)).rejects.toThrow('Admin key required');
});
test('first failure persists at least fifteen minutes of cooldown', async () => {
    await Payout.failWalletSweepAttempt(7,new Error('[031083] Address generated too frequently'));
    const [sql,params] = db.query.mock.calls[0];
    expect(sql).toContain("ELSE datetime('now','+15 minutes')");
    expect(params[1]).toBe('Binance rate limit - cooling down');
});
test('uncertain outbound attempt blocks account and settlement retries', async () => {
    const error = Object.assign(new Error('upstream failure'),{externalOutcomeUnknown:true});
    await Payout.failWalletSweepAttempt(7,error);
    expect(db.query.mock.calls[0][1][0]).toBe(1);
    expect(db.query.mock.calls[0][1][1]).toMatch(/^UNKNOWN:/);
    expect(await Jobs.fail(5,'binance_lightning',error)).toBe('unknown');
});
test('config save cannot release unknown external outcomes', async () => {
    await Payout.resetSweepCooldown(7);
    expect(db.query.mock.calls[0][0]).toContain("last_error NOT LIKE 'UNKNOWN:%'");
});
