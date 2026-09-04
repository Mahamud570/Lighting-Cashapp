const express = require('express');
const router = express.Router();
const db = require('../database/db');
const axios = require('axios');
const crypto = require('crypto');
const qrcode = require('qrcode');
const { logSafeError } = require('../utils/safeError');
const LNbitsService  = require('../services/lnbitsService');
const BlinkService   = require('../services/blinkService');
const AlbyService    = require('../services/albyService');
const PayoutService  = require('../services/payoutService');
const InvoiceChecker = require('../services/invoiceChecker'); // DRY fix BUG-003
const GeoIpService   = require('../services/geoIpService');

const fs = require('fs');
const path = require('path');

const isDemoSlug = slug => slug === 'test' || slug === 'demo';
const demoAllowed = () => process.env.NODE_ENV !== 'production' || process.env.ALLOW_DEMO_PAYMENTS === '1';
const escapeAttr = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

function publicInvoiceFailure(err) {
    const status = Number(err?.response?.status || err?.statusCode || 0);
    const providerText = String(
        err?.response?.data?.detail ||
        err?.response?.data?.message ||
        err?.response?.data?.msg ||
        err?.message || ''
    );

    if (/channel\s+(?:has\s+been\s+)?shut\s*down|channel\s+closed|no\s+active\s+channel/i.test(providerText)) {
        return {
            status: 503,
            message: 'This merchant\'s payment wallet is temporarily unavailable. Please contact the merchant.'
        };
    }

    if (status === 401 || status === 403 || /unauthori[sz]ed|invalid\s+(?:api\s*)?key|forbidden/i.test(providerText)) {
        return {
            status: 503,
            message: 'This merchant\'s payment wallet needs attention. Please contact the merchant.'
        };
    }

    return {
        status: 500,
        message: 'Failed to generate invoice. Please try again or contact the merchant.'
    };
}

const createCashStyleQr = value => qrcode.toDataURL(value, {
    errorCorrectionLevel: 'H',
    color: {
        dark: '#ffffff',
        light: '#000000'
    },
    margin: 4,
    width: 640
});

function publicBaseUrl(req) {
    const configured = String(process.env.PUBLIC_BASE_URL || '').trim().replace(/\/$/, '');
    if (/^https:\/\/[A-Za-z0-9.-]+(?::\d+)?$/i.test(configured) || (process.env.NODE_ENV !== 'production' && /^http:\/\/[A-Za-z0-9.-]+(?::\d+)?$/i.test(configured))) return configured;
    const host = String(req.get('host') || '').trim().replace(/^www\./i, '');
    const safeHost = /^[A-Za-z0-9.-]+(?::\d+)?$/.test(host) ? host : 'localhost';
    return `${req.secure ? 'https' : 'http'}://${safeHost}`;
}

// SVG Social Preview Card (1200x630) for Telegram, WhatsApp, Twitter, iMessage
router.get('/pay/:slug/preview.svg', async (req, res) => {
    try {
        const [links] = await db.query(
            "SELECT * FROM payment_links WHERE slug = ? AND status = 'active'",
            [req.params.slug]
        );
        const link = links[0] || { title: req.params.slug, brand_name: 'Cash App', slug: req.params.slug };
        const title = String(link.title || link.slug || 'Cash App').replace(/[<>&"']/g, '').trim().slice(0, 28) || 'Cash App';
        const initial = title.charAt(0).toUpperCase();

        const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="1200" height="630" viewBox="0 0 1200 630" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect width="1200" height="630" rx="22" fill="#00df3b"/>
  <circle cx="155" cy="130" r="78" fill="#d5b77c"/>
  <text x="155" y="158" fill="#ffffff" font-family="Arial, Helvetica, sans-serif" font-size="82" font-weight="700" text-anchor="middle">${initial}</text>
  <g transform="translate(1000,42)">
    <rect width="145" height="145" rx="32" fill="#050a08"/>
    <rect x="36" y="25" width="73" height="94" rx="20" fill="#00df3b"/>
    <text x="72" y="96" fill="#050a08" font-family="Arial, Helvetica, sans-serif" font-size="70" font-weight="900" text-anchor="middle">$</text>
  </g>
  <text x="80" y="525" fill="#020805" font-family="Arial, Helvetica, sans-serif" font-size="92" font-weight="900">${title}</text>
  <text x="82" y="590" fill="#020805" font-family="Arial, Helvetica, sans-serif" font-size="42" font-weight="800">${title}</text>
</svg>`;

        res.setHeader('Content-Type', 'image/svg+xml');
        res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=86400');
        res.send(svg);
    } catch (e) {
        res.status(500).send('Error generating card');
    }
});

// Public payment page: GET /pay/:slug (Injected with dynamic OpenGraph meta tags)
router.get('/pay/:slug', async (req, res) => {
    try {
        let link;
        if (isDemoSlug(req.params.slug)) {
            if (!demoAllowed()) return res.status(404).sendFile('404.html', { root: path.join(__dirname, '../public') });
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
                "SELECT pl.*, r.charge_mode AS reseller_charge_mode, r.charge_value AS reseller_charge_value, r.wallet_type FROM payment_links pl LEFT JOIN resellers r ON pl.reseller_id = r.id WHERE pl.slug = ? AND pl.status = 'active'",
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

        const baseUrl = publicBaseUrl(req);
        const pageUrl = `${baseUrl}/pay/${encodeURIComponent(link.slug)}`;
        const fullPreviewImg = `${baseUrl}/img/cashapp-social-card.png`;
        const personalizedPreviewImg = `${baseUrl}/pay/${encodeURIComponent(link.slug)}/preview.svg?v=2`;
        const userAgent = String(req.headers['user-agent'] || '');
        const fullPreviewCrawler = /TelegramBot|WhatsApp|facebookexternalhit|Facebot|Twitterbot|Discordbot|Slackbot|LinkedInBot/i.test(userAgent);
        const applePreviewClient = /AppleLinkPresentation|com\.apple\.WebKit\.Networking|CFNetwork|iMessage|Applebot|iPhone|iPad|Macintosh/i.test(userAgent);
        const compactPreview = link.preview_mode === 'imessage_compact' && applePreviewClient && !fullPreviewCrawler;
        const recipientName = escapeAttr(link.title || link.slug || 'Cash App');
        const ogTitle = compactPreview ? `Pay ${recipientName}` : 'Pay with Cash App';
        const ogDesc = 'Pay instantly, securely. ⚡';
        const brandName = escapeAttr(link.brand_name || 'Cash App');
        const compactTextTags = compactPreview ? '' : `
  <meta name="description" content="${ogDesc}">
  <meta property="og:site_name" content="${brandName}">
  <meta property="og:description" content="${ogDesc}">
  <meta name="twitter:description" content="${ogDesc}">`;
        const previewImg = compactPreview ? personalizedPreviewImg : fullPreviewImg;
        const previewImageType = compactPreview ? 'image/svg+xml' : 'image/png';
        const imageTags = `
  <meta property="og:image" content="${escapeAttr(previewImg)}">
  <meta property="og:image:url" content="${escapeAttr(previewImg)}">
  <meta property="og:image:secure_url" content="${escapeAttr(previewImg)}">
  <meta property="og:image:type" content="${previewImageType}">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:image:alt" content="Cash App — Pay instantly, securely">
  <meta name="twitter:image" content="${escapeAttr(previewImg)}">
  <meta name="twitter:image:alt" content="${compactPreview ? `Pay ${recipientName}` : 'Cash App — Pay instantly, securely'}">`;

        const metaTags = `
  <title>${ogTitle}</title>
  <link rel="canonical" href="${escapeAttr(pageUrl)}">
  <meta property="og:type" content="website">
  <meta property="og:url" content="${escapeAttr(pageUrl)}">
  <meta property="og:title" content="${ogTitle}">
  ${compactTextTags}
  ${imageTags}
  <meta name="twitter:card" content="${compactPreview ? 'summary' : 'summary_large_image'}">
  <meta name="twitter:title" content="${ogTitle}">
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
        if (isDemoSlug(req.params.slug)) {
            if (!demoAllowed()) return res.status(404).json({ error: 'Payment link not found' });
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
            `SELECT pl.*, r.charge_mode AS reseller_charge_mode, r.charge_value AS reseller_charge_value, r.wallet_type, r.wallet_email
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
            charge_mode: link.charge_mode === 'inherit' ? link.reseller_charge_mode : link.charge_mode,
            charge_value: link.charge_mode === 'inherit' ? link.reseller_charge_value : link.charge_value,
            wallet_configured: !!link.wallet_type
        });
    } catch (err) {
        console.error('[pay] Link info error:', err && err.message ? err.message : err);
        res.status(500).json({ error: 'Failed to load payment link' });
    }
});

// POST /api/pay/:slug/invoice - create invoice
router.post('/api/pay/:slug/invoice', async (req, res) => {
    try {
        const { amount, note } = req.body;

        if (isDemoSlug(req.params.slug)) {
            if (!demoAllowed()) return res.status(404).json({ error: 'Payment link not found' });
            const amountUsd = parseFloat(amount || 1);
            if (!Number.isFinite(amountUsd) || amountUsd <= 0 || amountUsd > 2000) return res.status(400).json({ error: 'Amount must be between $0.01 and $2,000' });
            const btcPrice = await PayoutService.getBtcPrice().catch(() => 65000);
            const totalSats = Math.round((amountUsd / btcPrice) * 100000000);
            const mockBolt11 = `lnbc${totalSats}u1pdemo${Date.now()}mockinvoicetest`;
            const qrCode = await createCashStyleQr(`lightning:${mockBolt11}`);
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
             r.charge_mode AS reseller_charge_mode, r.charge_value AS reseller_charge_value, r.id as reseller_id, r.status as reseller_status,
             r.payments_paused, r.max_payment_usd, r.max_daily_volume_usd
             FROM payment_links pl
             LEFT JOIN resellers r ON pl.reseller_id = r.id
             WHERE pl.slug = ? AND pl.status = 'active'`,
            [req.params.slug]
        );

        if (!links.length) return res.status(404).json({ error: 'Link not found' });
        const link = links[0];
        const effectiveChargeMode = link.charge_mode === 'inherit' ? link.reseller_charge_mode : link.charge_mode;
        const effectiveChargeValue = link.charge_mode === 'inherit' ? link.reseller_charge_value : link.charge_value;

        const [platformRows] = await db.query('SELECT key,value FROM platform_settings');
        const platform = Object.fromEntries(platformRows.map(row => [row.key, row.value]));
        if (platform.maintenance_mode === '1') return res.status(503).json({ error: 'Payments are temporarily unavailable during scheduled maintenance' });
        if (platform.payments_paused === '1') return res.status(503).json({ error: 'New payments are temporarily paused' });
        if (link.reseller_status !== 'active' || Number(link.payments_paused)) return res.status(503).json({ error: 'This merchant is not accepting new payments right now' });
        if (platform.provider_paused && platform.provider_paused === link.wallet_type) return res.status(503).json({ error: 'This payment provider is temporarily paused' });

        let amountUsd = parseFloat(amount);
        if (isNaN(amountUsd) || !isFinite(amountUsd) || amountUsd <= 0) {
            return res.status(400).json({ error: 'Valid positive payment amount required' });
        }
        const effectiveMax = Math.min(...[Number(platform.max_payment_usd)||Infinity,Number(link.max_payment_usd)||Infinity].filter(Number.isFinite));
        if (Number.isFinite(effectiveMax) && amountUsd > effectiveMax) return res.status(400).json({ error: `Maximum payment amount is $${effectiveMax.toFixed(2)}` });
        const dailyLimit = Math.min(...[Number(platform.daily_volume_limit_usd)||Infinity,Number(link.max_daily_volume_usd)||Infinity].filter(Number.isFinite));
        if (Number.isFinite(dailyLimit)) {
            const [[daily]] = await db.query("SELECT COALESCE(SUM(total_usd),0) total FROM payments WHERE reseller_id=? AND status IN ('pending','paid') AND created_at>=date('now')",[link.reseller_id]);
            if (Number(daily.total||0)+amountUsd > dailyLimit) return res.status(429).json({ error: 'Daily payment limit has been reached for this merchant' });
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

        // Calculate and validate charge
        let chargeUsd = 0;
        if (effectiveChargeMode === 'fixed') {
            const parsedVal = parseFloat(effectiveChargeValue);
            if (!isNaN(parsedVal) && isFinite(parsedVal) && parsedVal > 0) {
                chargeUsd = Math.min(parsedVal, 100); // capped at $100 max fee
            }
        } else if (effectiveChargeMode === 'percent') {
            const parsedVal = parseFloat(effectiveChargeValue);
            if (!isNaN(parsedVal) && isFinite(parsedVal) && parsedVal > 0) {
                const percent = Math.min(parsedVal, 50); // capped at 50% max fee
                chargeUsd = (amountUsd * percent) / 100;
            }
        }
        const totalUsd = parseFloat((amountUsd + chargeUsd).toFixed(2));
        if (isNaN(totalUsd) || !isFinite(totalUsd) || totalUsd <= 0) {
            return res.status(400).json({ error: 'Invalid total payment amount' });
        }

        const btcPrice = await PayoutService.getBtcPrice();
        const totalSats = Math.max(1, Math.round((totalUsd / btcPrice) * 100000000));

        let invoiceData = {};

        if (link.wallet_type === 'lnbits' && link.lnbits_invoice_key) {
            const webhookUrl = `${publicBaseUrl(req)}/api/webhooks/lnbits`;
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
                const targetAddress = parsedNwc?.lud16 || link.wallet_email;
                if (!targetAddress) {
                    return res.status(400).json({ error: 'No Lightning address associated with this NWC connection. Please configure a Lightning Address in Wallet Settings.' });
                }
                const resolvedInvoice = await PayoutService.resolveLightningAddressInvoice(targetAddress, totalSats);
                const payreq = resolvedInvoice.paymentRequest;
                invoiceData = {
                    invoice_id: `nwc_${Date.now()}`,
                    lightning_invoice: payreq,
                    uri: `lightning:${payreq}`,
                    provider: 'alby',
                    btc_amount: totalSats / 100000000,
                    verify_url: resolvedInvoice.verifyUrl
                };
            }
        } else if (link.wallet_type === 'opennode') {
            const baseUrl = link.opennode_env === 'dev' ? 'https://dev-api.opennode.com' : 'https://api.opennode.com';
            const resp = await axios.post(`${baseUrl}/v1/charges`, {
                amount: totalUsd,
                currency: 'USD',
                description: link.title || 'Lightning Payment',
                order_id: `lp_${Date.now()}`
            }, { headers: { Authorization: link.opennode_api_key }, timeout: 10000 });

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
                { headers: { Authorization: `token ${link.btcpay_api_key}` }, timeout: 10000 }
            );

            invoiceData = {
                invoice_id: resp.data.id,
                lightning_invoice: resp.data.checkoutLink,
                btcpay_checkout: resp.data.checkoutLink,
                provider: 'btcpay'
            };
        } else {
            // Default / Email / Lightning Address (e.g. user@blink.sv or user@walletofsatoshi.com)
            const lightningAddress = link.wallet_email;
            if (!lightningAddress) {
                return res.status(400).json({ error: 'No Lightning receiving address configured for this link. Please configure your wallet settings.' });
            }
            try {
                const resolvedInvoice = await PayoutService.resolveLightningAddressInvoice(lightningAddress, totalSats);
                const payreq = resolvedInvoice.paymentRequest;
                invoiceData = {
                    invoice_id: `ln_${Date.now()}`,
                    lightning_invoice: payreq,
                    uri: `lightning:${payreq}`,
                    provider: 'email',
                    btc_amount: totalSats / 100000000,
                    verify_url: resolvedInvoice.verifyUrl
                };
            } catch(lnErr) {
                console.error('LNURL resolution error, failing safely:', lnErr.message);
                return res.status(400).json({ error: 'Failed to resolve Lightning Address for this payment. Please verify your wallet configuration.' });
            }
        }

        const clientIp = req.clientIp || req.ip || '127.0.0.1';
        const payerLocation = await GeoIpService.lookup(clientIp);
        const statusToken = crypto.randomBytes(24).toString('hex');

        const [result] = await db.query(
            `INSERT INTO payments
             (link_id, reseller_id, invoice_id, public_status_token, provider, amount_usd, charge_usd, total_usd,
              amount_sats, btc_amount, lightning_invoice, verify_url, status, expires_at, payer_ip, payer_location, payer_note, receiving_wallet)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', datetime('now', '+15 minutes'), ?, ?, ?, ?)`,
            [
                link.id, link.reseller_id, invoiceData.invoice_id, statusToken, invoiceData.provider,
                amountUsd, chargeUsd, totalUsd,
                totalSats,
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
            qrDataUrl = await createCashStyleQr(qrTarget);
        }

        res.json({
            payment_id:      result.insertId,
            status_token:    statusToken,
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
        logSafeError('[pay] Invoice creation failed:', err);
        const failure = publicInvoiceFailure(err);
        res.status(failure.status).json({ error: failure.message });
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
             WHERE p.public_status_token = ?`,
            [req.params.id]
        );
        if (!payments.length) return res.status(404).json({ error: 'Invoice not found' });
        const payment = payments[0];

        if (payment.status === 'pending') {
            // BUG-003 FIX: Use shared InvoiceChecker instead of duplicated if/else chain
            const { paid } = await InvoiceChecker.check(payment);

            if (paid) {
                const [updateResult] = await db.query(
                    "UPDATE payments SET status = 'paid', paid_at = datetime('now') WHERE id = ? AND status = 'pending'",
                    [payment.id]
                );

                if (updateResult && updateResult.affectedRows === 1) {
                    payment.status = 'paid';
                    payment.paid_at = new Date().toISOString();

                    if (req.app.get('io')) {
                        req.app.get('io').to(`reseller:${payment.reseller_id}`).emit('payment:update', { id: payment.id, status: 'paid' });
                        req.app.get('io').to(`payment:${payment.id}`).emit('status', { status: 'paid' });
                    }

                    // Trigger auto-settlement pipeline exactly once
                    PayoutService.processAutoSettlement(payment.id, req.app.get('io')).catch(err => {
                        console.error('[pay] Auto settlement error in status poll:', err);
                    });
                } else {
                    payment.status = 'paid';
                }
            }
        }

        res.json({ status: payment.status, paid_at: payment.paid_at });
    } catch (err) {
        console.error('[pay] Invoice status error:', err && err.message ? err.message : err);
        res.status(500).json({ error: 'Failed to check invoice status' });
    }
});

module.exports = router;
