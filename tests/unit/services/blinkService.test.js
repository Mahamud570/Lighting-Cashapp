/**
 * Unit Tests: services/blinkService.js
 * Covers: createInvoice, checkInvoice (>25 tx edge case), payInvoice, getWalletDetails.
 * All HTTP calls are mocked via axios.
 */
jest.mock('axios');
const axios = require('axios');
const BlinkService = require('../../../services/blinkService');

const MOCK_API_KEY = 'test_blink_api_key';

beforeEach(() => jest.clearAllMocks());

// ── getWalletDetails ──────────────────────────────────────────────────────────
test('getWalletDetails: returns btc wallet balance and id', async () => {
    axios.post.mockResolvedValue({
        data: {
            data: {
                me: {
                    id: 'user1', username: 'alice',
                    defaultAccount: {
                        id: 'acc1',
                        wallets: [
                            { id: 'btc_wallet_id', walletCurrency: 'BTC', balance: 50000 }
                        ]
                    }
                }
            }
        }
    });
    const result = await BlinkService.getWalletDetails({ apiKey: MOCK_API_KEY });
    expect(result.wallet_id).toBe('btc_wallet_id');
    expect(result.balance_sats).toBe(50000);
    expect(result.username).toBe('alice');
});

// ── createInvoice ─────────────────────────────────────────────────────────────
test('createInvoice: returns payment_request and payment_hash', async () => {
    axios.post
        .mockResolvedValueOnce({ data: { data: { me: { id: 'u1', username: 'alice', defaultAccount: { id: 'acc1', wallets: [{ id: 'w1', walletCurrency: 'BTC', balance: 0 }] } } } } })
        .mockResolvedValueOnce({
            data: {
                data: {
                    lnInvoiceCreate: {
                        errors: [],
                        invoice: {
                            paymentRequest: 'lnbc500...', paymentHash: 'hash123', paymentSecret: 'sec', satoshis: 500
                        }
                    }
                }
            }
        });
    const result = await BlinkService.createInvoice({ apiKey: MOCK_API_KEY, amountSats: 500, memo: 'test' });
    expect(result.payment_request).toBe('lnbc500...');
    expect(result.payment_hash).toBe('hash123');
    expect(result.satoshis).toBe(500);
});

test('createInvoice: throws when Blink returns errors array', async () => {
    axios.post
        .mockResolvedValueOnce({ data: { data: { me: { id: 'u1', username: 'a', defaultAccount: { id: 'acc1', wallets: [{ id: 'w1', walletCurrency: 'BTC', balance: 0 }] } } } } })
        .mockResolvedValueOnce({
            data: { data: { lnInvoiceCreate: { errors: [{ message: 'Insufficient balance' }], invoice: null } } }
        });
    await expect(BlinkService.createInvoice({ apiKey: MOCK_API_KEY, amountSats: 9999999 }))
        .rejects.toThrow('Insufficient balance');
});

// ── checkInvoice (BUG-007 regression) ────────────────────────────────────────
test('checkInvoice: finds paid tx at position > 25 in list (BUG-007 regression)', async () => {
    // Simulate 30 pending transactions, then the paid one at position 30
    const pendingTx = { node: { id: 'x', status: 'PENDING', settlementAmount: 0, initiationVia: { paymentHash: 'other_hash' } } };
    const paidTx    = { node: { id: 'tx_paid', status: 'SUCCESS', settlementAmount: 1000, initiationVia: { paymentHash: 'target_hash' } } };
    const edges = [...Array(29).fill(pendingTx), paidTx];

    axios.post.mockResolvedValue({
        data: { data: { me: { defaultAccount: { wallets: [{ id: 'w1', walletCurrency: 'BTC', transactions: { edges } }] } } } }
    });

    const result = await BlinkService.checkInvoice({ apiKey: MOCK_API_KEY, paymentHash: 'target_hash' });
    expect(result.paid).toBe(true);
    expect(result.amount_sats).toBe(1000);
    expect(result.txid).toBe('tx_paid');
});

test('checkInvoice: returns paid=false when hash not found', async () => {
    axios.post.mockResolvedValue({
        data: { data: { me: { defaultAccount: { wallets: [{ id: 'w1', walletCurrency: 'BTC', transactions: { edges: [] } }] } } } }
    });
    const result = await BlinkService.checkInvoice({ apiKey: MOCK_API_KEY, paymentHash: 'missing_hash' });
    expect(result.paid).toBe(false);
});

test('checkInvoice: returns paid=false on API error (no throw)', async () => {
    axios.post.mockRejectedValue(new Error('Network error'));
    const result = await BlinkService.checkInvoice({ apiKey: MOCK_API_KEY, paymentHash: 'h1' });
    expect(result.paid).toBe(false);
});

// ── payInvoice ────────────────────────────────────────────────────────────────
test('payInvoice: success returns status and fee', async () => {
    axios.post
        .mockResolvedValueOnce({ data: { data: { me: { id: 'u1', username: 'a', defaultAccount: { id: 'acc1', wallets: [{ id: 'w1', walletCurrency: 'BTC', balance: 50000 }] } } } } })
        .mockResolvedValueOnce({
            data: {
                data: {
                    lnInvoicePaymentSend: {
                        errors: [],
                        status: 'SUCCESS',
                        transaction: { id: 'tx1', settlementAmount: -1000, settlementFee: 5 }
                    }
                }
            }
        });
    const result = await BlinkService.payInvoice({ apiKey: MOCK_API_KEY, paymentRequest: 'lnbc1000...' });
    expect(result.status).toBe('SUCCESS');
    expect(result.fee_sats).toBe(5);
});
