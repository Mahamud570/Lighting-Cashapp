jest.mock('axios', () => ({ post: jest.fn(), get: jest.fn() }));

const axios = require('axios');
const TelegramService = require('../../../services/telegramService');

beforeEach(() => jest.clearAllMocks());

test('Telegram HTTP 400 is marked permanent and preserves the safe provider reason', async () => {
    axios.post.mockRejectedValueOnce({
        response: { status: 400, data: { description: 'Bad Request: chat not found' } }
    });

    await expect(TelegramService.sendMessage({
        botToken: 'dummy-token', chatId: '123', message: 'Test'
    })).rejects.toMatchObject({
        status: 400,
        permanent: true,
        message: 'Telegram rejected notification: Bad Request: chat not found'
    });
});

test('temporary Telegram network failure remains retryable', async () => {
    axios.post.mockRejectedValueOnce({ code: 'ETIMEDOUT' });

    await expect(TelegramService.sendMessage({
        botToken: 'dummy-token', chatId: '123', message: 'Test'
    })).rejects.toMatchObject({ code: 'ETIMEDOUT', permanent: false });
});

test('payment alert includes source link and full invoice ID', async () => {
    axios.post.mockResolvedValueOnce({ data: { ok: true, result: { message_id: 77 } } });
    await TelegramService.sendPaymentAlert({
        botToken: 'dummy-token', chatId: '123', settlementStatus: 'processing',
        payment: {
            total_usd: 56, amount_sats: 70000, slug: 'baby', link_title: 'Cash App',
            provider: 'lnbits', invoice_id: 'invoice-full-value-1234567890'
        }
    });
    const payload = axios.post.mock.calls[0][1];
    expect(payload.text).toContain('Cash App — /baby');
    expect(payload.text).toContain('invoice-full-value-1234567890');
    expect(payload.text).not.toContain('...');
});

test('sweep alert prints the complete transaction hash', async () => {
    axios.post.mockResolvedValueOnce({ data: { ok: true } });
    const txid = '37ec00b1882817e03891520da6a18b0632d414d90d822f1791c3ebd1abe0971f';
    await TelegramService.sendSweepAlert({
        botToken: 'dummy-token', chatId: '123',
        sweep: { amount_usd: 200, amount_sats: 250000, status: 'completed', txid }
    });
    expect(axios.post.mock.calls[0][1].text).toContain(txid);
});
