const assert = require('assert');
const BinanceService = require('../services/binanceService');
const LNbitsService = require('../services/lnbitsService');
const BlinkService = require('../services/blinkService');
const AlbyService = require('../services/albyService');
const PayoutService = require('../services/payoutService');

async function runTests() {
    console.log('🧪 Starting Automated Settlement & Gateway Unit Tests...\n');

    // Test 1: Binance HMAC-SHA256 Signer
    console.log('Test 1: Binance HMAC Signature Generation');
    const queryString = 'coin=BTC&network=LIGHTNING&timestamp=1700000000000';
    const secret = 'mock_secret_key_123';
    const sig = BinanceService.sign(queryString, secret);
    assert.strictEqual(typeof sig, 'string');
    assert.strictEqual(sig.length, 64);
    console.log('  ✅ Signature generated successfully:', sig.substring(0, 16) + '...');

    // Test 2: Alby NWC String Parser
    console.log('\nTest 2: Alby / Nostr Wallet Connect Parser');
    const nwcUri = 'nostr+walletconnect://0123456789abcdef?relay=wss://relay.damus.io&secret=fedcba9876543210&lud16=alice@getalby.com';
    const parsed = AlbyService.parseNwcUri(nwcUri);
    assert.strictEqual(parsed.pubkey, '0123456789abcdef');
    assert.strictEqual(parsed.relay, 'wss://relay.damus.io');
    assert.strictEqual(parsed.secret, 'fedcba9876543210');
    assert.strictEqual(parsed.lud16, 'alice@getalby.com');
    console.log('  ✅ NWC URI parsed successfully:', parsed.lud16);

    // Test 3: LNbits URL Normalization
    console.log('\nTest 3: LNbits URL Normalization');
    const rawUrl = 'https://legend.lnbits.com///';
    const norm = LNbitsService.normalizeUrl(rawUrl);
    assert.strictEqual(norm, 'https://legend.lnbits.com');
    console.log('  ✅ URL Normalized:', norm);

    // Test 4: Spot Price & Sats Calculation
    console.log('\nTest 4: Live BTC Spot Price & Calculation');
    const btcPrice = await PayoutService.getBtcPrice();
    assert.strictEqual(typeof btcPrice, 'number');
    assert(btcPrice > 1000);
    const testUsd = 25.00;
    const testSats = Math.round((testUsd / btcPrice) * 100000000);
    console.log(`  ✅ Current BTC: $${btcPrice.toLocaleString()} -> $${testUsd} = ${testSats.toLocaleString()} sats`);

    console.log('\n🎉 ALL AUTOMATED SETTLEMENT TESTS PASSED SUCCESSFULLY!');
}

runTests().catch(err => {
    console.error('❌ Test failed:', err);
    process.exit(1);
});
