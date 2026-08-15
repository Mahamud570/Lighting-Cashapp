const express = require('express');
const router = express.Router();
const db = require('../database/db');
const axios = require('axios');
const qrcode = require('qrcode');
const LNbitsService = require('../services/lnbitsService');
const BlinkService = require('../services/blinkService');
const AlbyService = require('../services/albyService');
const PayoutService = require('../services/payoutService');

// Public payment page: GET /pay/:slug
router.get('/pay/:slug', async (req, res) => {
    try {
        const [links] = await db.query(
            "SELECT pl.*, r.charge_mode, r.charge_value, r.wallet_type FROM payment_links pl LEFT JOIN resellers r ON pl.reseller_id = r.id WHERE pl.slug = ? AND pl.status = 'active'",
            [req.params.slug]
        );

        if (!links.length) {
            return res.status(404).sendFile('404.html', { root: './public' });
        }

        const link = links[0];

        // Track click
        const ua = req.headers['user-agent'] || '';
        const device = /mobile/i.test(ua) ? 'Mobile' : 'Desktop';
        await db.query(
            'INSERT INTO link_clicks (link_id, ip, device, browser) VALUES (?,?,?,?)',
            [link.id, req.ip, device, ua.substring(0, 100)]
        );
        await db.query('UPDATE payment_links SET clicks = clicks + 1 WHERE id = ?', [link.id]);

        // Serve the payment page
        res.sendFile('pay.html', { root: './public' });
    } catch (err) {
        console.error(err);
        res.status(500).send('Server error');
    }
});

// GET /api/pay/:slug/info - get link info for payment page JS
router.get('/api/pay/:slug/info', async (req, res) => {
    try {
        const [links] = await db.query(
            `SELECT pl.*, r.charge_mode, r.charge_value, r.wallet_type, r.wallet_email
             FROM payment_links pl
             LEFT JOIN resellers r ON pl.reseller_id = r.id
             WHERE pl.slug = ? AND pl.status = 'active'`,
            [req.params.slug]
        );

        if (!links.length) return res.status(404).json({ error: 'Payment link not found' });

        const link = links[0];
        res.json({
            slug: link.slug,
            title: link.title,
            brand_name: link.brand_name,
            logo_path: link.logo_path,
            theme: link.theme,
            amount_type: link.amount_type,
            fixed_amount: link.fixed_amount,
            min_amount: link.min_amount,
            max_amount: link.max_amount,
            charge_mode: link.charge_mode,
            charge_value: link.charge_value,
            wallet_configured: !!link.wallet_type
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/pay/:slug/invoice - create invoice
router.post('/api/pay/:slug/invoice', async (req, res) => {
    try {
        const { amount, note } = req.body;
        const [links] = await db.query(
            `SELECT pl.*, r.wallet_type, r.wallet_email, r.opennode_api_key, r.opennode_env,
             r.btcpay_url, r.btcpay_store_id, r.btcpay_api_key,
             r.lnbits_url, r.lnbits_invoice_key, r.lnbits_admin_key,
             r.blink_api_key, r.blink_wallet_id,
             r.alby_access_token, r.alby_nwc_string,
             r.charge_mode, r.charge_value, r.id as reseller_id
             FROM payment_links pl
             LEFT JOIN resellers r ON pl.reseller_id = r.id
             WHERE pl.slug = ? AND pl.status = 'active'`,
            [req.params.slug]
        );

        if (!links.length) return res.status(404).json({ error: 'Link not found' });
        const link = links[0];

        const amountUsd = parseFloat(amount);
        if (isNaN(amountUsd) || amountUsd < link.min_amount || amountUsd > link.max_amount) {
            return res.status(400).json({ error: `Amount must be between $${link.min_amount} and $${link.max_amount}` });
        }

        // Calculate charge
        let chargeUsd = 0;
        if (link.charge_mode === 'fixed') chargeUsd = parseFloat(link.charge_value);
        if (link.charge_mode === 'percent') chargeUsd = (amountUsd * parseFloat(link.charge_value)) / 100;
        const totalUsd = amountUsd + chargeUsd;

        const btcPrice = await PayoutService.getBtcPrice();
        const totalSats = Math.round((totalUsd / btcPrice) * 100000000);

        let invoiceData = {};

        if (link.wallet_type === 'lnbits' && link.lnbits_invoice_key) {
            const webhookUrl = `${req.protocol}://${req.get('host')}/api/webhooks/lnbits`;
            const lnbitsRes = await LNbitsService.createInvoice({
                url: link.lnbits_url,
                invoiceKey: link.lnbits_invoice_key,
                amountSats: totalSats,
                memo: link.title || 'Cash App Payment',
                webhookUrl
            });

            invoiceData = {
                invoice_id: lnbitsRes.payment_hash,
                lightning_invoice: lnbitsRes.payment_request,
                uri: `lightning:${lnbitsRes.payment_request}`,
                provider: 'lnbits',
                btc_amount: totalSats / 100000000
            };
        } else if (link.wallet_type === 'blink' && link.blink_api_key) {
            const blinkRes = await BlinkService.createInvoice({
                apiKey: link.blink_api_key,
                walletId: link.blink_wallet_id,
                amountSats: totalSats,
                memo: link.title || 'Cash App Payment'
            });

            invoiceData = {
                invoice_id: blinkRes.payment_hash,
                lightning_invoice: blinkRes.payment_request,
                uri: `lightning:${blinkRes.payment_request}`,
                provider: 'blink',
                btc_amount: totalSats / 100000000
            };
        } else if (link.wallet_type === 'alby' && link.alby_access_token) {
            const albyRes = await AlbyService.createInvoice({
                accessToken: link.alby_access_token,
                amountSats: totalSats,
                memo: link.title || 'Cash App Payment'
            });

            invoiceData = {
                invoice_id: albyRes.payment_hash,
                lightning_invoice: albyRes.payment_request,
                uri: `lightning:${albyRes.payment_request}`,
                provider: 'alby',
                btc_amount: totalSats / 100000000
            };
        } else if (link.wallet_type === 'opennode') {
            const baseUrl = link.opennode_env === 'dev' ? 'https://dev-api.opennode.com' : 'https://api.opennode.com';
            const resp = await axios.post(`${baseUrl}/v1/charges`, {
                amount: totalUsd,
                currency: 'USD',
                description: link.title || 'Lightning Payment',
                order_id: `lp_${Date.now()}`
            }, { headers: { Authorization: link.opennode_api_key } });

            const chargeData = resp.data.data;
            invoiceData = {
                invoice_id: chargeData.id,
                lightning_invoice: chargeData.lightning_invoice?.payreq,
                uri: chargeData.uri,
                hosted_checkout: chargeData.hosted_checkout_url,
                provider: 'opennode'
            };
        } else if (link.wallet_type === 'btcpay') {
            const resp = await axios.post(
                `${link.btcpay_url}/api/v1/stores/${link.btcpay_store_id}/invoices`,
                {
                    amount: totalUsd,
                    currency: 'USD',
                    metadata: { orderId: `lp_${Date.now()}`, itemDesc: link.title }
                },
                { headers: { Authorization: `token ${link.btcpay_api_key}` } }
            );

            invoiceData = {
                invoice_id: resp.data.id,
                lightning_invoice: resp.data.checkoutLink,
                btcpay_checkout: resp.data.checkoutLink,
                provider: 'btcpay'
            };
        } else {
            // Default / Email / Lightning Address (e.g. user@blink.sv or user@walletofsatoshi.com)
            const lightningAddress = link.wallet_email || 'imposter@coinos.io';
            try {
                const payreq = await PayoutService.resolveLightningAddress(lightningAddress, totalSats);
                invoiceData = {
                    invoice_id: `ln_${Date.now()}`,
                    lightning_invoice: payreq,
                    uri: `lightning:${payreq}`,
                    provider: 'email',
                    btc_amount: totalSats / 100000000
                };
            } catch(lnErr) {
                console.error('LNURL resolution error, falling back to manual:', lnErr.message);
                invoiceData = {
                    invoice_id: `manual_${Date.now()}`,
                    lightning_invoice: null,
                    provider: 'email'
                };
            }
        }

        const [result] = await db.query(
            `INSERT INTO payments (link_id, reseller_id, invoice_id, provider, amount_usd, charge_usd, total_usd, btc_amount, lightning_invoice, verify_url, status, expires_at, payer_ip, payer_note, receiving_wallet)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', datetime('now', '+15 minutes'), ?, ?, ?)`,
            [link.id, link.reseller_id, invoiceData.invoice_id, invoiceData.provider, amountUsd, chargeUsd, totalUsd, invoiceData.btc_amount || null, invoiceData.lightning_invoice || null, invoiceData.verify_url || null, req.ip, note || null, link.wallet_type || 'email']
        );

        let qrDataUrl = null;
        const qrTarget = invoiceData.uri || (invoiceData.lightning_invoice ? `lightning:${invoiceData.lightning_invoice}` : null);
        if (qrTarget) {
            qrDataUrl = await qrcode.toDataURL(qrTarget, {
                color: {
                    dark: '#000000',
                    light: '#ffffff'
                },
                margin: 1,
                width: 320
            });
        }

        res.json({
            payment_id: result.insertId,
            invoice_id: invoiceData.invoice_id,
            lightning_invoice: invoiceData.lightning_invoice,
            uri: invoiceData.uri,
            hosted_checkout: invoiceData.hosted_checkout,
            btcpay_checkout: invoiceData.btcpay_checkout,
            provider: invoiceData.provider,
            amount_usd: amountUsd,
            charge_usd: chargeUsd,
            total_usd: totalUsd,
            sats: totalSats,
            qr_code: qrDataUrl,
            expires_in: 900 // 15 minutes
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// GET /api/pay/invoice/:id/status
router.get('/api/pay/invoice/:id/status', async (req, res) => {
    try {
        const [payments] = await db.query(
            `SELECT p.*, r.wallet_type, r.opennode_api_key, r.opennode_env,
             r.lnbits_url, r.lnbits_invoice_key,
             r.blink_api_key, r.blink_wallet_id
             FROM payments p 
             LEFT JOIN resellers r ON p.reseller_id = r.id 
             WHERE p.id = ? OR p.invoice_id = ?`,
            [req.params.id, req.params.id]
        );
        if (!payments.length) return res.status(404).json({ error: 'Invoice not found' });
        const payment = payments[0];

        if (payment.status === 'pending') {
            let markedPaid = false;

            if (payment.wallet_type === 'blink' && payment.blink_api_key && payment.invoice_id) {
                try {
                    const check = await BlinkService.checkInvoice({
                        apiKey: payment.blink_api_key,
                        paymentHash: payment.invoice_id
                    });
                    if (check.paid) markedPaid = true;
                } catch(e) {}
            } else if (payment.wallet_type === 'lnbits' && payment.lnbits_invoice_key && payment.invoice_id) {
                try {
                    const check = await LNbitsService.checkInvoice({
                        url: payment.lnbits_url,
                        invoiceKey: payment.lnbits_invoice_key,
                        paymentHash: payment.invoice_id
                    });
                    if (check.paid) markedPaid = true;
                } catch(e) {}
            } else if (payment.wallet_type === 'opennode' && payment.invoice_id) {
                try {
                    const base = payment.opennode_env === 'dev' ? 'https://dev-api.opennode.com' : 'https://api.opennode.com';
                    const resp = await axios.get(`${base}/v1/charges/${payment.invoice_id}`, {
                        headers: { Authorization: payment.opennode_api_key }
                    });
                    if (resp.data?.data?.status === 'paid') markedPaid = true;
                } catch(e) {}
            } else if (payment.verify_url) {
                try {
                    const resp = await axios.get(payment.verify_url, { timeout: 2500 });
                    if (resp.data && (resp.data.settled === true || resp.data.status === 'PAID')) {
                        markedPaid = true;
                    }
                } catch(e) {}
            }

            if (markedPaid) {
                await db.query('UPDATE payments SET status = "paid", paid_at = datetime("now") WHERE id = ?', [payment.id]);
                payment.status = 'paid';

                // Trigger auto settlement pipeline
                PayoutService.processAutoSettlement(payment.id, req.app.get('io')).catch(err => {
                    console.error('Auto settlement error in status poll:', err);
                });
            }
        }

        res.json({ status: payment.status, paid_at: payment.paid_at });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
