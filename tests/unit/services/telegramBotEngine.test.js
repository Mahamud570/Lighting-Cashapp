jest.useFakeTimers();
jest.mock('axios', () => ({ get: jest.fn(), post: jest.fn() }));
jest.mock('../../../database/db', () => ({ query: jest.fn() }));
jest.mock('../../../services/blinkService', () => ({}));
jest.mock('../../../services/binanceService', () => ({}));
jest.mock('../../../services/payoutService', () => ({}));

const db = require('../../../database/db');
const { TelegramBotEngine } = require('../../../services/telegramBotEngine');

afterEach(() => jest.clearAllTimers());

test('409 conflicts pause polling for fifteen minutes without logging credentials', async () => {
    const axios = require('axios');
    const engine = new TelegramBotEngine();
    engine.running = true;
    const state = { token: 'test-token', polling: false, lastUpdateId: 0, disabledUntil: 0 };
    engine.botStates.set(state.token, state);
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});
    axios.get.mockRejectedValueOnce({ response: { status: 409, data: { description: 'Conflict: webhook is active test-token' } } });
    await engine.pollBot(state);
    expect(state.disabledUntil).toBe(Date.now() + 900000);
    expect(JSON.stringify(log.mock.calls)).not.toContain('test-token');
    expect(log.mock.calls[0][1].message).toContain('webhook');
    engine.stop();
    log.mockRestore();
});

test('stopping the engine aborts an active long poll', async () => {
    const axios = require('axios');
    const engine = new TelegramBotEngine();
    engine.running = true;
    const state = { token: 'test-token', polling: false, lastUpdateId: 0, disabledUntil: 0 };
    engine.botStates.set(state.token, state);
    axios.get.mockImplementationOnce((_url, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('cancelled')));
    }));
    const poll = engine.pollBot(state);
    engine.stop();
    await poll;
    expect(state.controller.signal.aborted).toBe(true);
    expect(state.timer).toBeUndefined();
});

test('interactive bot engine loads every configured reseller and groups shared bot tokens', async () => {
    db.query.mockResolvedValueOnce([[
        { id: 1, status: 'active', telegram_bot_token: 'token-a', telegram_chat_id: '101' },
        { id: 2, status: 'active', telegram_bot_token: 'token-b', telegram_chat_id: '202' },
        { id: 3, status: 'active', telegram_bot_token: 'token-a', telegram_chat_id: '303' }
    ]]);
    const engine = new TelegramBotEngine();
    engine.running = true;
    await engine.refreshBots();
    expect(db.query.mock.calls[0][0]).not.toContain('LIMIT 1');
    expect(engine.botStates.size).toBe(2);
    expect(engine.botStates.get('token-a').resellersByChat.size).toBe(2);
    engine.stop();
});
