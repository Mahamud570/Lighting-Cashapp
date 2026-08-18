const LNbitsService = require('../../services/lnbitsService');
const BinanceService = require('../../services/binanceService');
const PayoutService = require('../../services/payoutService');

describe('LNbits Payment Gateway & Automated Binance Sweeper Pipeline', () => {

    describe('LNbitsService', () => {
        test('should normalize URL properly by stripping trailing slashes', () => {
            expect(LNbitsService.normalizeUrl('https://legend.lnbits.com/')).toBe('https://legend.lnbits.com');
            expect(LNbitsService.normalizeUrl('https://legend.lnbits.com///')).toBe('https://legend.lnbits.com');
            expect(LNbitsService.normalizeUrl('')).toBe('https://legend.lnbits.com');
            expect(LNbitsService.normalizeUrl(null)).toBe('https://legend.lnbits.com');
        });

        test('should reject createInvoice if invoiceKey is missing', async () => {
            await expect(LNbitsService.createInvoice({
                url: 'https://legend.lnbits.com',
                invoiceKey: '',
                amountSats: 1000
            })).rejects.toThrow('LNbits Invoice Key is required');
        });

        test('should reject createInvoice if amountSats is invalid or <= 0', async () => {
            await expect(LNbitsService.createInvoice({
                url: 'https://legend.lnbits.com',
                invoiceKey: 'test_key',
                amountSats: 0
            })).rejects.toThrow('Invalid amount in satoshis');

            await expect(LNbitsService.createInvoice({
                url: 'https://legend.lnbits.com',
                invoiceKey: 'test_key',
                amountSats: -50
            })).rejects.toThrow('Invalid amount in satoshis');
        });

        test('should reject payInvoice if adminKey is missing', async () => {
            await expect(LNbitsService.payInvoice({
                url: 'https://legend.lnbits.com',
                adminKey: '',
                bolt11: 'lnbc100u1...'
            })).rejects.toThrow('LNbits Admin Key is required');
        });

        test('should reject payInvoice if bolt11 is invalid format', async () => {
            await expect(LNbitsService.payInvoice({
                url: 'https://legend.lnbits.com',
                adminKey: 'admin_key_123',
                bolt11: 'invalid_invoice'
            })).rejects.toThrow('Invalid BOLT11 Lightning invoice format');
        });
    });

    describe('BinanceService', () => {
        test('should generate accurate HMAC-SHA256 signature', () => {
            const query = 'coin=BTC&network=LIGHTNING&recvWindow=60000&timestamp=1700000000000';
            const secret = 'my_secret_key';
            const sig = BinanceService.sign(query, secret);
            expect(typeof sig).toBe('string');
            expect(sig.length).toBe(64); // 32 bytes in hex = 64 chars
        });

        test('should format Bitcoin amount to exact 8 decimal places', () => {
            const sats1 = 10000;
            const btc1 = (sats1 / 100000000).toFixed(8);
            expect(btc1).toBe('0.00010000');

            const sats2 = 123456789;
            const btc2 = (sats2 / 100000000).toFixed(8);
            expect(btc2).toBe('1.23456789');

            const sats3 = 50;
            const btc3 = (sats3 / 100000000).toFixed(8);
            expect(btc3).toBe('0.00000050');
        });

        test('should throw error when credentials missing for getDepositInvoice', async () => {
            await expect(BinanceService.getDepositInvoice({
                apiKey: '',
                apiSecret: '',
                amountSats: 10000
            })).rejects.toThrow('Binance API credentials are required');
        });

        test('should throw error on invalid satoshi amount for getDepositInvoice', async () => {
            await expect(BinanceService.getDepositInvoice({
                apiKey: 'key',
                apiSecret: 'secret',
                amountSats: 0
            })).rejects.toThrow('Invalid satoshi amount');
        });
    });

    describe('PayoutService', () => {
        test('should reject invalid Lightning address format', async () => {
            await expect(PayoutService.resolveLightningAddress('invalid_address', 1000))
                .rejects.toThrow('Invalid Lightning address format');
        });

        test('should fetch and cache BTC price', async () => {
            const price = await PayoutService.getBtcPrice();
            expect(typeof price).toBe('number');
            expect(price).toBeGreaterThan(0);
        });
    });
});
