const express = require('express');
const router = express.Router();
const db = require('../database/db');
const axios = require('axios');
const qrcode = require('qrcode');
const LNbitsService  = require('../services/lnbitsService');
const BlinkService   = require('../services/blinkService');
const AlbyService    = require('../services/albyService');
const PayoutService  = require('../services/payoutService');
const InvoiceChecker = require('../services/invoiceChecker'); // DRY fix BUG-003
const GeoIpService   = require('../services/geoIpService');

const fs = require('fs');
const path = require('path');

// SVG Social Preview Card (1200x630) for Telegram, WhatsApp, Twitter, iMessage
router.get('/pay/:slug/preview.svg', async (req, res) => {
    try {
        const [links] = await db.query(
            "SELECT * FROM payment_links WHERE slug = ? AND status = 'active'",
            [req.params.slug]
        );
        const link = links[0] || { title: req.params.slug, brand_name: 'Cash App', slug: req.params.slug };
        const title = (link.brand_name || link.title || 'Cash App').replace(/[<>&"]/g, '');

        const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="1200" height="630" viewBox="0 0 1200 630" fill="none" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <!-- Background Gradient -->
    <radialGradient id="bgGlow" cx="30%" cy="50%" r="60%">
      <stop offset="0%" stop-color="#14231b" stop-opacity="0.8"/>
      <stop offset="100%" stop-color="#0b0e14" stop-opacity="1"/>
    </radialGradient>

    <!-- Cash App Neon Glow Filter -->
    <filter id="cashGlow" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="35" result="blur1"/>
      <feGaussianBlur stdDeviation="15" result="blur2"/>
      <feMerge>
        <feMergeNode in="blur1"/>
        <feMergeNode in="blur2"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
  </defs>

  <!-- Deep Dark Slate Background -->
  <rect width="1200" height="630" fill="url(#bgGlow)"/>

  <!-- Glowing Cash App Aura -->
  <rect x="150" y="165" width="300" height="300" rx="70" fill="#00D632" opacity="0.35" filter="url(#cashGlow)"/>

  <!-- Cash App Squircle Icon -->
  <g transform="translate(170, 185)">
    <rect width="260" height="260" rx="60" fill="#00D632"/>
    <text x="130" y="185" fill="#FFFFFF" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="165" font-weight="900" text-anchor="middle">$</text>
  </g>

  <!-- Cash App Brand Typography -->
  <text x="490" y="305" fill="#FFFFFF" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="115" font-weight="800" letter-spacing="-1">Cash App</text>
  
  <!-- Subtitle with Lightning Bolt -->
  <text x="495" y="380" fill="#CBD5E1" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="44" font-weight="500">
    Pay instantly, securely. <tspan fill="#00D632" font-size="46">⚡</tspan>
  </text>
</svg>`;

        res.setHeader('Content-Type', 'image/svg+xml');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.send(svg);
    } catch (e) {
        res.status(500).send('Error generating card');
    }
});

// Public payment page: GET /pay/:slug (Injected with dynamic OpenGraph meta tags)
router.get('/pay/:slug', async (req, res) => {
    try {
        let link;
        if (req.params.slug === 'test' || req.params.slug === 'demo') {
            link = {
                id: 0,
                slug: req.params.slug,
                title: 'Demo Cash App Pay',
                brand_name: 'Cash Pay',
                theme: req.query.theme || 'default',
                status: 'active'
            };
        } else {
            const [links] = await db.query(
                "SELECT pl.*, r.charge_mode, r.charge_value, r.wallet_type FROM payment_links pl LEFT JOIN resellers r ON pl.reseller_id = r.id WHERE pl.slug = ? AND pl.status = 'active'",
                [req.params.slug]
            );

            if (!links.length) {
                return res.status(404).sendFile('404.html', { root: path.join(__dirname, '../public') });
            }

            link = links[0];

            // Track click
            const ua = req.headers['user-agent'] || '';
            const device = /mobile/i.test(ua) ? 'Mobile' : 'Desktop';
            await db.query(
                'INSERT INTO link_clicks (link_id, ip, device, browser) VALUES (?,?,?,?)',
                [link.id, req.ip, device, ua.substring(0, 100)]
            );
            await db.query('UPDATE payment_links SET clicks = clicks + 1 WHERE id = ?', [link.id]);
        }

        // Load pay.html template and inject dynamic Open Graph & Twitter Card tags
        const payHtmlPath = path.join(__dirname, '../public/pay.html');
        let html = fs.readFileSync(payHtmlPath, 'utf8');

        const protocol = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
        const host = req.headers['host'] || 'portal-cash-app.com';
        const pageUrl = `${protocol}://${host}/pay/${link.slug}`;
        const previewImg = `${protocol}://${host}/img/cashapp-banner.png`;
        const ogTitle = `Pay with CashApp`;
        const ogDesc = 'Pay instantly, securely. ⚡';
        const brandName = link.brand_name || 'Cash App';

        const metaTags = `
  <title>${ogTitle}</title>
  <meta name="description" content="${ogDesc}">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="${brandName}">
  <meta property="og:url" content="${pageUrl}">
  <meta property="og:title" content="${ogTitle}">
  <meta property="og:description" content="${ogDesc}">
  <meta property="og:image" content="${previewImg}">
  <meta property="og:image:secure_url" content="${previewImg}">
  <meta property="og:image:type" content="image/png">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${ogTitle}">
  <meta name="twitter:description" content="${ogDesc}">
  <meta name="twitter:image" content="${previewImg}">
  <meta name="theme-color" content="#00D632">
        `;

        html = html.replace('<title id="pageTitle">Cash App — Scan to Pay</title>', metaTags);

        res.send(html);
    } catch (err) {
        console.error(err);
        res.status(500).send('Server error');
    }
});

// GET /api/pay/:slug/info - get link info for payment page JS
router.get('/api/pay/:slug/info', async (req, res) => {
    try {
        if (req.params.slug === 'test' || req.params.slug === 'demo') {
            const themeKey = req.query.theme || 'default';
            return res.json({
                slug: req.params.slug,
                title: 'Demo Cash App Pay',
                brand_name: 'Cash Pay',
                logo_path: null,
                theme: themeKey,
                amount_type: 'open',
                fixed_amount: null,
                min_amount: 1,
                max_amount: 2000,
                charge_mode: 'none',
                charge_value: 0,
                wallet_configured: true
            });
        }

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

        if (req.params.slug === 'test' || req.params.slug === 'demo') {
            const amountUsd = parseFloat(amount || 1);
            const btcPrice = await PayoutService.getBtcPrice().catch(() => 65000);
            const totalSats = Math.round((amountUsd / btcPrice) * 100000000);
            const mockBolt11 = `lnbc${totalSats}u1pdemo${Date.now()}mockinvoicetest`;
            const qrCode = await qrcode.toDataURL(`lightning:${mockBolt11}`);
            return res.json({
                success: true,
                payment_id: 0,
                invoice_id: 'demo_hash_' + Date.now(),
                payment_hash: 'demo_hash_' + Date.now(),
                lightning_invoice: mockBolt11,
                qr_code: qrCode,
                amount_usd: amountUsd,
                charge_usd: 0,
                total_usd: amountUsd,
                sats: totalSats,
                expires_in: 900
            });
        }
        const [links] = await db.query(
            `SELECT pl.*, r.wallet_type, r.wallet_email, r.opennode_api_key, r.opennode_env,
             r.btcpay_url, r.btcpay_store_id, r.btcpay_api_key,
             r.lnbits_url, r.lnbits_invoice_key, r.lnbits_admin_key,
             r.blink_api_key, r.blink_api_keys, r.blink_wallet_id,
             r.alby_access_token, r.alby_nwc_string,
             r.charge_mode, r.charge_value, r.id as reseller_id
             FROM payment_links pl
             LEFT JOIN resellers r ON pl.reseller_id = r.id
             WHERE pl.slug = ? AND pl.status = 'active'`,
            [req.params.slug]
        );

        if (!links.length) return res.status(404).json({ error: 'Link not found' });
        const link = links[0];

        let amountUsd = parseFloat(amount);
        if (isNaN(amountUsd) || !isFinite(amountUsd) || amountUsd <= 0) {
            return res.status(400).json({ error: 'Valid positive payment amount required' });
        }

        if (link.amount_type === 'fixed') {
            const fixed = parseFloat(link.fixed_amount);
            if (!isNaN(fixed) && fixed > 0) {
                if (Math.abs(amountUsd - fixed) > 0.001) {
                    return res.status(400).json({ error: `This payment link requires an exact fixed amount of $${fixed.toFixed(2)}` });
                }
                amountUsd = fixed;
            }
        } else {
            const minAmount = link.min_amount != null ? parseFloat(link.min_amount) : 1;
            const maxAmount = link.max_amount != null ? parseFloat(link.max_amount) : Infinity;

            if (amountUsd < minAmount || amountUsd > maxAmount) {
                return res.status(400).json({ error: `Amount must be between $${minAmount} and $${link.max_amount ?? '∞'}` });
            }
        }

        // Sanitize payer note: max 500 chars, strip control characters
        const payerNote = note ? String(note).replace(/[\x00-\x1F\x7F]/g, '').substring(0, 500) : null;

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
        } else if (link.wallet_type === 'blink' && (link.blink_api_key || link.blink_api_keys)) {
            const blinkRes = await BlinkService.createInvoice({
                apiKey: link.blink_api_key,
                apiKeys: link.blink_api_keys,
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
        } else if (link.wallet_type === 'alby' && (link.alby_access_token || link.alby_nwc_string)) {
            if (link.alby_access_token) {
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
            } else {
                const parsedNwc = AlbyService.parseNwcUri(link.alby_nwc_string);
                const targetAddress = parsedNwc?.lud16 || link.wallet_email || 'imposter@coinos.io';
                const payreq = await PayoutService.resolveLightningAddress(targetAddress, totalSats);
                invoiceData = {
                    invoice_id: `nwc_${Date.now()}`,
                    lightning_invoice: payreq,
                    uri: `lightning:${payreq}`,
                    provider: 'alby',
                    btc_amount: totalSats / 100000000
                };
            }
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

        const clientIp = req.clientIp || req.ip || '127.0.0.1';
        const payerLocation = await GeoIpService.lookup(clientIp);

        const [result] = await db.query(
            `INSERT INTO payments
             (link_id, reseller_id, invoice_id, provider, amount_usd, charge_usd, total_usd,
              btc_amount, lightning_invoice, verify_url, status, expires_at, payer_ip, payer_location, payer_note, receiving_wallet)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', datetime('now', '+15 minutes'), ?, ?, ?, ?)`,
            [
                link.id, link.reseller_id, invoiceData.invoice_id, invoiceData.provider,
                amountUsd, chargeUsd, totalUsd,
                invoiceData.btc_amount || null,
                invoiceData.lightning_invoice || null,
                invoiceData.verify_url || null,
                clientIp,
                payerLocation,
                payerNote,               // sanitized note (500 char max)
                link.wallet_type || 'email'
            ]
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
            payment_id:      result.insertId,
            invoice_id:      invoiceData.invoice_id,
            lightning_invoice: invoiceData.lightning_invoice,
            uri:             invoiceData.uri,
            hosted_checkout: invoiceData.hosted_checkout,
            btcpay_checkout: invoiceData.btcpay_checkout,
            provider:        invoiceData.provider,
            amount_usd:      amountUsd,
            charge_usd:      chargeUsd,
            total_usd:       totalUsd,
            sats:            totalSats,
            qr_code:         qrDataUrl,
            expires_in:      900 // 15 minutes
        });
    } catch (err) {
        console.error('[pay] Invoice creation error:', err);
        let errMsg = err.response?.data?.detail || err.response?.data?.message || err.message || 'Failed to create invoice. Please try again.';
        if (/api[_-]?key|secret|token|password|sk_live|bearer/i.test(errMsg)) {
            errMsg = 'Failed to generate invoice. Please verify your payment wallet settings.';
        }
        res.status(500).json({ error: errMsg });
    }
});

// GET /api/pay/invoice/:id/status
router.get('/api/pay/invoice/:id/status', async (req, res) => {
    try {
        const [payments] = await db.query(
            `SELECT p.*, r.wallet_type, r.opennode_api_key, r.opennode_env,
             r.lnbits_url, r.lnbits_invoice_key,
             r.blink_api_key, r.blink_api_keys, r.blink_wallet_id
             FROM payments p 
             LEFT JOIN resellers r ON p.reseller_id = r.id 
             WHERE p.id = ? OR p.invoice_id = ?`,
            [req.params.id, req.params.id]
        );
        if (!payments.length) return res.status(404).json({ error: 'Invoice not found' });
        const payment = payments[0];

        if (payment.status === 'pending') {
            // BUG-003 FIX: Use shared InvoiceChecker instead of duplicated if/else chain
            const { paid } = await InvoiceChecker.check(payment);

            if (paid) {
                await db.query(
                    "UPDATE payments SET status = 'paid', paid_at = datetime('now') WHERE id = ?",
                    [payment.id]
                );
                payment.status = 'paid';

                // Trigger auto-settlement pipeline (fire-and-forget)
                PayoutService.processAutoSettlement(payment.id, req.app.get('io')).catch(err => {
                    console.error('[pay] Auto settlement error in status poll:', err);
                });
            }
        }

        res.json({ status: payment.status, paid_at: payment.paid_at });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
