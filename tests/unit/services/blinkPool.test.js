/**
 * Unit Tests: Multi-Blink API Key Pool Support
 * Tests: BlinkService.parseApiKeys, Multi-Key invoice creation rotation, multi-key checkInvoice.
 */
jest.mock('axios');
const axios = require('axios');
const BlinkService = require('../../../services/blinkService');

beforeEach(() => jest.clearAllMocks());

test('parseApiKeys: parses string, array, and fallback correctly', () => {
    const parsed1 = BlinkService.parseApiKeys('key1', 'key2\nkey3,key4');
    expect(parsed1).toEqual(['key1', 'key2', 'key3', 'key4']);

    const parsed2 = BlinkService.parseApiKeys('key1', '["key2", "key3"]');
    expect(parsed2).toEqual(['key1', 'key2', 'key3']);

    const parsed3 = BlinkService.parseApiKeys(null, ['keyA', 'keyB']);
    expect(parsed3).toEqual(['keyA', 'keyB']);
});

test('createInvoice: falls back to key 2 when key 1 fails', async () => {
    // Key 1 fails with $1,000 volume limit error
    axios.post
        .mockRejectedValueOnce(new Error('Volume limit hit on key1'))
        // Key 2 wallet lookup OK
        .mockResolvedValueOnce({ data: { data: { me: { id: 'u2', defaultAccount: { wallets: [{ id: 'w2', walletCurrency: 'BTC' }] } } } } })
        // Key 2 invoice creation OK
        .mockResolvedValueOnce({
            data: {
                data: {
                    lnInvoiceCreate: {
                        errors: [],
                        invoice: { paymentRequest: 'lnbc200...', paymentHash: 'hash2', satoshis: 200 }
                    }
                }
            }
        });

    const res = await BlinkService.createInvoice({
        apiKey: 'key1',
        apiKeys: ['key1', 'key2'],
        amountSats: 200
    });

    expect(res.payment_hash).toBe('hash2');
    expect(res.used_key).toBe('key2');
});

test('checkInvoice: checks key 2 if key 1 does not find payment', async () => {
    // Key 1 returns no transactions
    axios.post
        .mockResolvedValueOnce({ data: { data: { me: { defaultAccount: { wallets: [{ id: 'w1', walletCurrency: 'BTC', transactions: { edges: [] } }] } } } } })
        // Key 2 finds settled transaction
        .mockResolvedValueOnce({
            data: {
                data: {
                    me: {
                        defaultAccount: {
                            wallets: [{
                                id: 'w2', walletCurrency: 'BTC',
                                transactions: {
                                    edges: [{ node: { id: 'tx2', status: 'SUCCESS', settlementAmount: 500, initiationVia: { paymentHash: 'target_hash' } } }]
                                }
                            }]
                        }
                    }
                }
            }
        });

    const res = await BlinkService.checkInvoice({
        apiKey: 'key1',
        apiKeys: ['key1', 'key2'],
        paymentHash: 'target_hash'
    });

    expect(res.paid).toBe(true);
    expect(res.amount_sats).toBe(500);
    expect(res.used_key).toBe('key2');
});
