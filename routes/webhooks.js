const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const db = require('../database/db');
const PayoutService = require('../services/payoutService');
const InvoiceChecker = require('../services/invoiceChecker');

/**
 * Helper to mark payment as paid atomically and dispatch auto-settlement & real-time socket events
 */
async function handlePaymentSuccess(payment, io, gatewayName, payload) {
    const [updateResult] = await db.query(
        "UPDATE payments SET status = 'paid', paid_at = datetime('now') WHERE id = ? AND status = 'pending'",
        [payment.id]
    );

    if (!updateResult || updateResult.affectedRows !== 1) return;

    await db.query(
        'INSERT OR IGNORE INTO webhook_events (reseller_id, gateway, event_id, event_type, payload, processed, status) VALUES (?, ?, ?, ?, ?, 1, "processed")',
        [payment.reseller_id, gatewayName, payment.invoice_id || `evt_${Date.now()}`, 'payment_settled', JSON.stringify(payload)]
    ).catch(() => {});

    if (io) {
        io.to(`reseller:${payment.reseller_id}`).emit('payment:update', { id: payment.id, status: 'paid' });
        io.to(`payment:${payment.id}`).emit('status', { status: 'paid' });
    }

    PayoutService.processAutoSettlement(payment.id, io).catch(err => {
        console.error('Auto settlement trigger error:', err);
    });
}

async function findPendingPayment(condition, params) {
    const [payments] = await db.query(
        `SELECT p.*, r.wallet_type, r.opennode_api_key, r.opennode_env, r.btcpay_webhook_secret,
                r.lnbits_url, r.lnbits_invoice_key, r.blink_api_key, r.blink_api_keys, r.blink_wallet_id,
                r.alby_access_token, r.alby_nwc_string
         FROM payments p
         JOIN resellers r ON p.reseller_id = r.id
         WHERE ${condition} AND p.status = 'pending'
         LIMIT 1`,
        params
    );
    return payments[0] || null;
}

router.post('/api/webhooks/lnbits', async (req, res) => {
    try {
        const body = req.body;
        const paymentHash = body.payment_hash || body.checking_id;
        const bolt11 = body.bolt11 || body.payment_request;
        if (!paymentHash && !bolt11) return res.status(400).json({ error: 'Missing payment identifier' });

        const payment = await findPendingPayment(
            'p.lightning_invoice = ? OR p.invoice_id = ?',
            [bolt11 || paymentHash, paymentHash || bolt11]
        );
        if (!payment) return res.status(404).json({ error: 'Pending payment not found' });

        const check = await InvoiceChecker.check(payment);
        if (!check.paid) return res.status(400).json({ error: 'Payment not settled on LNbits node' });

        await handlePaymentSuccess(payment, req.app.get('io'), 'lnbits', body);
        res.json({ success: true, message: 'LNbits webhook processed' });
    } catch (err) {
        console.error('LNbits webhook error:', err);
        res.status(500).json({ error: 'Webhook processing error' });
    }
});

router.post('/api/webhooks/blink', async (req, res) => {
    try {
        const body = req.body;
        const paymentHash = body.data?.paymentHash || body.paymentHash;
        const paymentRequest = body.data?.paymentRequest || body.paymentRequest;

        const payment = await findPendingPayment(
            'p.lightning_invoice = ? OR p.invoice_id = ?',
            [paymentRequest || paymentHash, paymentHash || paymentRequest]
        );
        if (!payment) return res.status(404).json({ error: 'Pending payment not found' });

        const check = await InvoiceChecker.check(payment);
        if (!check.paid) return res.status(400).json({ error: 'Payment not settled on Blink node' });

        await handlePaymentSuccess(payment, req.app.get('io'), 'blink', body);
        res.json({ success: true, message: 'Blink webhook processed' });
    } catch (err) {
        console.error('Blink webhook error:', err);
        res.status(500).json({ error: 'Webhook processing error' });
    }
});

router.post('/api/webhooks/alby', async (req, res) => {
    try {
        const body = req.body;
        const paymentHash = body.data?.payment_hash || body.payment_hash;

        const payment = await findPendingPayment(
            'p.invoice_id = ? OR p.lightning_invoice LIKE ?',
            [paymentHash, `%${paymentHash}%`]
        );
        if (!payment) return res.status(404).json({ error: 'Pending payment not found' });

        const check = await InvoiceChecker.check(payment);
        if (!check.paid) return res.status(400).json({ error: 'Payment not verified on node' });

        await handlePaymentSuccess(payment, req.app.get('io'), 'alby', body);
        res.json({ success: true, message: 'Alby webhook processed' });
    } catch (err) {
        console.error('Alby webhook error:', err);
        res.status(500).json({ error: 'Webhook processing error' });
    }
});

router.post('/api/webhooks/opennode', async (req, res) => {
    try {
        const body = req.body;
        if (!body.id) return res.status(400).json({ error: 'Missing OpenNode charge ID' });

        const payment = await findPendingPayment('p.invoice_id = ?', [body.id]);
        if (!payment) return res.status(404).json({ error: 'Pending payment not found' });

        const receivedHash = req.headers['hashed_order'];
        if (!receivedHash || !payment.opennode_api_key) {
            return res.status(401).json({ error: 'Missing OpenNode webhook authentication credentials' });
        }

        const expectedHash = crypto.createHmac('sha256', payment.opennode_api_key).update(body.id).digest('hex');
        if (receivedHash !== expectedHash) {
            return res.status(401).json({ error: 'Invalid OpenNode HMAC signature' });
        }

        const check = await InvoiceChecker.check(payment);
        if (!check.paid && body.status !== 'paid') {
            return res.status(400).json({ error: 'Payment not confirmed on OpenNode' });
        }

        await handlePaymentSuccess(payment, req.app.get('io'), 'opennode', body);
        res.json({ success: true });
    } catch (err) {
        console.error('OpenNode webhook error:', err);
        res.status(500).json({ error: 'Webhook processing error' });
    }
});

// BTCPay requires a BTCPay-Sig HMAC over the exact raw request bytes.
// server.js captures req.rawBody before JSON parsing.
router.post('/api/webhooks/btcpay', async (req, res) => {
    try {
        const body = req.body;
        const invoiceId = body.invoiceId || body.id;
        if (!invoiceId) return res.status(400).json({ error: 'Missing BTCPay invoice ID' });

        const payment = await findPendingPayment('p.invoice_id = ?', [invoiceId]);
        if (!payment) return res.status(404).json({ error: 'Pending payment not found' });

        const webhookSecret = payment.btcpay_webhook_secret;
        const signature = req.get('BTCPAY-SIG');
        if (!webhookSecret || !signature || !req.rawBody) {
            return res.status(401).json({ error: 'Missing BTCPay webhook authentication credentials' });
        }

        const expected = Buffer.from(
            'sha256=' + crypto.createHmac('sha256', webhookSecret).update(req.rawBody).digest('hex'),
            'utf8'
        );
        const received = Buffer.from(String(signature).trim(), 'utf8');
        if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) {
            return res.status(401).json({ error: 'Invalid BTCPay webhook signature' });
        }

        // Only settle on an explicit BTCPay settled event.
        if (body.type !== 'InvoiceSettled' && body.type !== 'InvoicePaymentSettled' && body.status !== 'Settled') {
            return res.status(400).json({ error: 'Invoice not settled' });
        }

        // The BTCPay signature authenticates the event. Do not call the generic
        // InvoiceChecker here because it has no BTCPay node configuration and
        // would incorrectly reject valid BTCPay webhooks.
        await handlePaymentSuccess(payment, req.app.get('io'), 'btcpay', body);
        res.json({ success: true });
    } catch (err) {
        console.error('BTCPay webhook error:', err);
        res.status(500).json({ error: 'Webhook processing error' });
    }
});

module.exports = router;
