const express = require('express');
const router = express.Router();
const db = require('../database/db');
const PayoutService = require('../services/payoutService');

/**
 * Helper to mark payment as paid and dispatch auto-settlement & real-time socket events
 */
async function handlePaymentSuccess(payment, io, gatewayName, payload) {
    if (payment.status === 'paid') return; // already processed

    await db.query(
        "UPDATE payments SET status = 'paid', paid_at = datetime('now') WHERE id = ?",
        [payment.id]
    );

    // Record webhook audit log
    await db.query(
        'INSERT INTO webhook_events (reseller_id, gateway, event_id, event_type, payload, processed, status) VALUES (?, ?, ?, ?, ?, 1, "processed")',
        [payment.reseller_id, gatewayName, payment.invoice_id, 'payment_settled', JSON.stringify(payload)]
    );

    // Notify connected clients
    if (io) {
        io.to(`reseller:${payment.reseller_id}`).emit('payment:update', { id: payment.id, status: 'paid' });
        io.to(`payment:${payment.id}`).emit('status', { status: 'paid' });
    }

    // Trigger Automated LN Payout & Binance Auto-Sweep Engine
    PayoutService.processAutoSettlement(payment.id, io).catch(err => {
        console.error('Auto settlement trigger error:', err);
    });
}

// POST /api/webhooks/lnbits
router.post('/api/webhooks/lnbits', async (req, res) => {
    try {
        const body = req.body;
        const paymentHash = body.payment_hash || body.checking_id;
        const bolt11 = body.bolt11 || body.payment_request;

        if (!paymentHash && !bolt11) {
            return res.status(400).json({ error: 'Missing payment identifier' });
        }

        const [payments] = await db.query(
            `SELECT * FROM payments WHERE lightning_invoice = ? OR invoice_id = ? LIMIT 1`,
            [bolt11 || paymentHash, paymentHash || bolt11]
        );

        if (payments.length) {
            await handlePaymentSuccess(payments[0], req.app.get('io'), 'lnbits', body);
        }

        res.json({ success: true, message: 'LNbits webhook received' });
    } catch (err) {
        console.error('LNbits webhook error:', err);
        res.status(500).json({ error: err.message });
    }
});

// POST /api/webhooks/blink
router.post('/api/webhooks/blink', async (req, res) => {
    try {
        const body = req.body;
        const paymentHash = body.data?.paymentHash || body.paymentHash;
        const paymentRequest = body.data?.paymentRequest || body.paymentRequest;

        const [payments] = await db.query(
            `SELECT * FROM payments WHERE lightning_invoice = ? OR invoice_id = ? LIMIT 1`,
            [paymentRequest || paymentHash, paymentHash || paymentRequest]
        );

        if (payments.length) {
            await handlePaymentSuccess(payments[0], req.app.get('io'), 'blink', body);
        }

        res.json({ success: true, message: 'Blink webhook processed' });
    } catch (err) {
        console.error('Blink webhook error:', err);
        res.status(500).json({ error: err.message });
    }
});

// POST /api/webhooks/alby
router.post('/api/webhooks/alby', async (req, res) => {
    try {
        const body = req.body;
        const paymentHash = body.data?.payment_hash || body.payment_hash;

        const [payments] = await db.query(
            `SELECT * FROM payments WHERE invoice_id = ? OR lightning_invoice LIKE ? LIMIT 1`,
            [paymentHash, `%${paymentHash}%`]
        );

        if (payments.length) {
            await handlePaymentSuccess(payments[0], req.app.get('io'), 'alby', body);
        }

        res.json({ success: true, message: 'Alby webhook processed' });
    } catch (err) {
        console.error('Alby webhook error:', err);
        res.status(500).json({ error: err.message });
    }
});

// POST /api/webhooks/opennode
router.post('/api/webhooks/opennode', async (req, res) => {
    try {
        const body = req.body;
        if (body.status === 'paid') {
            const [payments] = await db.query(
                `SELECT * FROM payments WHERE invoice_id = ? LIMIT 1`,
                [body.id]
            );

            if (payments.length) {
                await handlePaymentSuccess(payments[0], req.app.get('io'), 'opennode', body);
            }
        }

        res.json({ success: true });
    } catch (err) {
        console.error('OpenNode webhook error:', err);
        res.status(500).json({ error: err.message });
    }
});

// POST /api/webhooks/btcpay
router.post('/api/webhooks/btcpay', async (req, res) => {
    try {
        const body = req.body;
        if (body.type === 'InvoiceSettled' || body.type === 'InvoicePaymentSettled') {
            const [payments] = await db.query(
                `SELECT * FROM payments WHERE invoice_id = ? LIMIT 1`,
                [body.invoiceId]
            );

            if (payments.length) {
                await handlePaymentSuccess(payments[0], req.app.get('io'), 'btcpay', body);
            }
        }

        res.json({ success: true });
    } catch (err) {
        console.error('BTCPay webhook error:', err);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
