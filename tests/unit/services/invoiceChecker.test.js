jest.mock('../../../services/blinkService');
jest.mock('../../../services/lnbitsService');
jest.mock('axios');

const BlinkService   = require('../../../services/blinkService');
const LNbitsService  = require('../../../services/lnbitsService');
const axios          = require('axios');
const InvoiceChecker = require('../../../services/invoiceChecker');

const basePayment = {
    id: 1, invoice_id: 'abc123hash', wallet_type: 'lnbits',
    lnbits_url: 'https://legend.lnbits.com', lnbits_invoice_key: 'key123',
    blink_api_key: null, opennode_api_key: null, verify_url: null
};

beforeEach(() => jest.clearAllMocks());

test('LNbits paid=true -> { paid: true }', async () => {
    LNbitsService.checkInvoice.mockResolvedValue({ paid: true });
    const result = await InvoiceChecker.check({ ...basePayment, wallet_type: 'lnbits' });
    expect(result.paid).toBe(true);
});

test('LNbits paid=false -> { paid: false }', async () => {
    LNbitsService.checkInvoice.mockResolvedValue({ paid: false });
    const result = await InvoiceChecker.check({ ...basePayment, wallet_type: 'lnbits' });
    expect(result.paid).toBe(false);
});

test('LNbits network error -> { paid: false } no throw', async () => {
    LNbitsService.checkInvoice.mockRejectedValue(new Error('Timeout'));
    const result = await InvoiceChecker.check({ ...basePayment, wallet_type: 'lnbits' });
    expect(result.paid).toBe(false);
});

test('Blink paid=true -> { paid: true }', async () => {
    BlinkService.checkInvoice.mockResolvedValue({ paid: true });
    const result = await InvoiceChecker.check({ ...basePayment, wallet_type: 'blink', blink_api_key: 'key1', invoice_id: 'hash1' });
    expect(result.paid).toBe(true);
});

test('Blink paid=false -> { paid: false }', async () => {
    BlinkService.checkInvoice.mockResolvedValue({ paid: false });
    const result = await InvoiceChecker.check({ ...basePayment, wallet_type: 'blink', blink_api_key: 'key1', invoice_id: 'hash1' });
    expect(result.paid).toBe(false);
});

test('OpenNode status=paid -> { paid: true }', async () => {
    axios.get.mockResolvedValue({ data: { data: { status: 'paid' } } });
    const result = await InvoiceChecker.check({ ...basePayment, wallet_type: 'opennode', opennode_api_key: 'on_key', opennode_env: 'live', invoice_id: 'on1' });
    expect(result.paid).toBe(true);
});

test('OpenNode status=expired -> { paid: false, expired: true }', async () => {
    axios.get.mockResolvedValue({ data: { data: { status: 'expired' } } });
    const result = await InvoiceChecker.check({ ...basePayment, wallet_type: 'opennode', opennode_api_key: 'on_key', opennode_env: 'live', invoice_id: 'on2' });
    expect(result.paid).toBe(false);
    expect(result.expired).toBe(true);
});

test('OpenNode uses dev endpoint when opennode_env=dev', async () => {
    axios.get.mockResolvedValue({ data: { data: { status: 'pending' } } });
    await InvoiceChecker.check({ ...basePayment, wallet_type: 'opennode', opennode_api_key: 'on_key', opennode_env: 'dev', invoice_id: 'on3' });
    expect(axios.get).toHaveBeenCalledWith(expect.stringContaining('dev-api.opennode.com'), expect.any(Object));
});

test('verify_url settled=true -> { paid: true }', async () => {
    axios.get.mockResolvedValue({ data: { settled: true } });
    const result = await InvoiceChecker.check({ ...basePayment, wallet_type: 'email', lnbits_invoice_key: null, verify_url: 'https://verify.example.com/abc' });
    expect(result.paid).toBe(true);
});

test('verify_url status=PAID -> { paid: true }', async () => {
    axios.get.mockResolvedValue({ data: { status: 'PAID' } });
    const result = await InvoiceChecker.check({ ...basePayment, wallet_type: 'email', lnbits_invoice_key: null, verify_url: 'https://verify.example.com/def' });
    expect(result.paid).toBe(true);
});

test('no matching provider -> { paid: false }', async () => {
    const result = await InvoiceChecker.check({ id: 1, wallet_type: 'email', invoice_id: null, lnbits_invoice_key: null, blink_api_key: null, opennode_api_key: null, verify_url: null });
    expect(result.paid).toBe(false);
});
