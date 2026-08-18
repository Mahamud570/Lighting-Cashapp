const express = require('express');
const router = express.Router();
const db = require('../database/db');
const auth = require('../middleware/auth');
const { requireRole } = auth;
const BinanceService = require('../services/binanceService');
const PayoutService = require('../services/payoutService');

router.use('/api/sweeps*', auth, requireRole('reseller', 'owner'));

// GET /api/sweeps - list auto sweeps and payouts
router.get('/api/sweeps', auth, async (req, res) => {
    try {
        const [sweeps] = await db.query(
            `SELECT s.*, p.amount_usd as original_payment_usd, p.invoice_id as payment_invoice_id
             FROM auto_sweeps s
             LEFT JOIN payments p ON s.payment_id = p.id
             WHERE s.reseller_id = ?
             ORDER BY s.created_at DESC
             LIMIT 50`,
            [req.reseller.id]
        );

        res.json({ sweeps });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/sweeps/test-binance - test Binance API connection & check balances
router.post('/api/sweeps/test-binance', auth, async (req, res) => {
    try {
        const { api_key, api_secret } = req.body;
        const key = (api_key && !api_key.startsWith('***')) ? api_key.trim() : req.reseller.binance_api_key;
        const secret = (api_secret && !api_secret.startsWith('***')) ? api_secret.trim() : req.reseller.binance_api_secret;

        if (!key || !secret) {
            return res.status(400).json({ error: 'Binance API Key and Secret are required' });
        }

        const result = await BinanceService.testConnection({ apiKey: key, apiSecret: secret });
        res.json({
            success: true,
            message: 'Binance API Connected Successfully',
            data: result
        });
    } catch (err) {
        res.status(400).json({ error: 'Binance Connection Failed: ' + (err.response?.data?.msg || err.message) });
    }
});

// POST /api/sweeps/save-config - save Binance & Auto-Payout settings
router.post('/api/sweeps/save-config', auth, async (req, res) => {
    try {
        const {
            binance_api_key,
            binance_api_secret,
            binance_auto_sweep_enabled,
            binance_sweep_threshold_usd,
            binance_sweep_type,
            binance_sweep_wallet_balance_enabled,
            auto_payout_enabled,
            auto_payout_address,
            auto_payout_percent
        } = req.body;

        const cleanApiKey = (binance_api_key && !binance_api_key.startsWith('***')) ? binance_api_key.trim() : null;
        const cleanApiSecret = (binance_api_secret && !binance_api_secret.startsWith('***')) ? binance_api_secret.trim() : null;

        await db.query(
            `UPDATE resellers SET
                binance_api_key = COALESCE(?, binance_api_key),
                binance_api_secret = COALESCE(?, binance_api_secret),
                binance_auto_sweep_enabled = ?,
                binance_sweep_threshold_usd = ?,
                binance_sweep_type = ?,
                binance_sweep_wallet_balance_enabled = ?,
                auto_payout_enabled = ?,
                auto_payout_address = ?,
                auto_payout_percent = ?
             WHERE id = ?`,
            [
                cleanApiKey,
                cleanApiSecret,
                binance_auto_sweep_enabled ? 1 : 0,
                parseFloat(binance_sweep_threshold_usd) || 0,
                binance_sweep_type || 'lightning',
                binance_sweep_wallet_balance_enabled ? 1 : 0,
                auto_payout_enabled ? 1 : 0,
                auto_payout_address || null,
                parseFloat(auto_payout_percent) || 100,
                req.reseller.id
            ]
        );

        res.json({ success: true, message: 'Auto-Sweep and Settlement settings saved successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/sweeps/manual - manually trigger an instant sweep/payout
router.post('/api/sweeps/manual', auth, async (req, res) => {
    try {
        const { destination_type, destination_address, amount_usd } = req.body;
        const amount = parseFloat(amount_usd);

        if (isNaN(amount) || amount <= 0) {
            return res.status(400).json({ error: 'Valid amount in USD is required' });
        }

        const [resellers] = await db.query('SELECT * FROM resellers WHERE id = ?', [req.reseller.id]);
        const reseller = resellers[0];

        if (!reseller.wallet_type) {
            return res.status(400).json({ error: 'Please configure an active outbound gateway first (LNbits, Blink, Alby).' });
        }

        const btcPrice = await PayoutService.getBtcPrice();
        const totalSats = Math.round((amount / btcPrice) * 100000000);

        let bolt11 = null;
        let destLabel = destination_address;

        if (destination_type === 'binance') {
            if (!reseller.binance_api_key || !reseller.binance_api_secret) {
                return res.status(400).json({ error: 'Binance API credentials not configured.' });
            }
            const binanceInvoice = await BinanceService.getDepositInvoice({
                apiKey: reseller.binance_api_key,
                apiSecret: reseller.binance_api_secret,
                amountSats: totalSats,
                network: reseller.binance_sweep_type || 'LIGHTNING'
            });
            bolt11 = binanceInvoice.address;
            destLabel = 'Binance Exchange Deposit';
        } else if (destination_type === 'ln_address') {
            if (!destination_address || !destination_address.includes('@')) {
                return res.status(400).json({ error: 'Valid Lightning address is required.' });
            }
            bolt11 = await PayoutService.resolveLightningAddress(destination_address, totalSats);
        } else if (destination_type === 'bolt11') {
            bolt11 = destination_address;
        } else {
            return res.status(400).json({ error: 'Invalid destination type' });
        }

        const payRes = await PayoutService.executeGatewayPayment(reseller, bolt11, `Manual Sweep $${amount}`);

        await db.query(
            `INSERT INTO auto_sweeps (reseller_id, sweep_type, amount_sats, amount_usd, target_destination, txid, preimage, fee_sats, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'completed')`,
            [reseller.id, destination_type === 'binance' ? 'binance_lightning' : 'instant_ln_payout', totalSats, amount, destLabel, payRes.txid, payRes.preimage || null, payRes.fee_sats || 0]
        );

        res.json({
            success: true,
            message: `Successfully swept $${amount} (${totalSats} sats) to ${destLabel}`,
            txid: payRes.txid,
            preimage: payRes.preimage
        });
    } catch (err) {
        console.error('Manual sweep error:', err);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
