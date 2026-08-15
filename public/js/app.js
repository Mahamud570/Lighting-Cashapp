// ─── LIGHTNING PAY - DASHBOARD JS ─────────────────────────────
// Modern SPA with real-time updates via Socket.io

const API = '';
let currentPage = 'dashboard';
let allLinks = [];
let allUsers = [];
let socket;
let paymentRefreshInterval;
let selectedChargeMode = 'none';
let selectedProvider = null;
let selectedTheme = 'default';

// ─── INIT ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
    initSocket();
    await loadUser();
    await loadDashboard();
    loadThemes();

    // Auto-refresh payments every 10s when on payments page
    paymentRefreshInterval = setInterval(() => {
        if (currentPage === 'payments') loadPayments();
    }, 10000);
});

// ─── SOCKET.IO ─────────────────────────────────────────────────
function initSocket() {
    try {
        socket = io();
        socket.on('payment:update', (data) => {
            showToast(`💳 Payment ${data.status}!`, data.status === 'paid' ? 'success' : 'info');
            if (currentPage === 'dashboard') loadDashboard();
            if (currentPage === 'payments') loadPayments();
        });
        socket.on('sweep:update', (data) => {
            showToast(`🔄 Auto-Sweep ${data.status}! $${data.amount_usd} → ${data.destination}`, data.status === 'completed' ? 'success' : 'warning');
            if (currentPage === 'sweeps') loadSweeps();
        });
        socket.on('connect', () => {
            document.getElementById('liveIndicator').style.display = 'flex';
        });
    } catch(e) {}
}

// ─── NAVIGATION ────────────────────────────────────────────────
function navigate(page) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.nav-item[data-page]').forEach(n => n.classList.remove('active'));

    const pageEl = document.getElementById(`page-${page}`);
    if (pageEl) pageEl.classList.add('active');

    const navEl = document.querySelector(`.nav-item[data-page="${page}"]`);
    if (navEl) navEl.classList.add('active');

    currentPage = page;

    const titles = {
        dashboard: 'Dashboard', wallet: 'Lightning Wallet', sweeps: 'Auto-Sweeps & Binance',
        themes: 'Payment Themes', links: 'Payment Links', scancodes: 'My Scan Code',
        payments: 'Payments', activity: 'System Activity', users: 'Users',
        security: 'Security', devices: 'Device Login', charge: 'Transaction Charge',
        analytics: 'Analytics & Revenue', twofa: 'Two-Factor Authentication'
    };
    document.getElementById('topbarTitle').textContent = titles[page] || page;

    // Open settings group if navigating to sub-items
    if (['security','devices','charge','twofa'].includes(page)) {
        document.getElementById('settingsGroup').classList.add('open');
    }

    // Show/hide special page wrappers (analytics, twofa use their own layout)
    const specialPages = ['analytics', 'twofa'];
    document.querySelector('.main')?.style && (document.querySelector('.main').style.display =
        specialPages.includes(page) ? 'none' : '');
    specialPages.forEach(sp => {
        const w = document.getElementById(`page-${sp}-wrapper`);
        if (w) w.style.display = (sp === page) ? '' : 'none';
    });

    // Lazy-load page data
    const loaders = {
        wallet: loadWallet,
        sweeps: loadSweeps,
        themes: loadThemes,
        links: loadLinks,
        scancodes: loadScanCodes,
        payments: loadPayments,
        activity: loadActivity,
        users: loadUsers,
        security: loadSecurity,
        devices: loadDevices,
        charge: loadCharge,
        analytics: loadAnalytics,
        twofa: load2FA
    };
    if (loaders[page]) loaders[page]();

    // Close mobile sidebar
    document.getElementById('sidebar').classList.remove('open');
}

function toggleGroup(id) {
    document.getElementById(id).classList.toggle('open');
}

function toggleSidebar() {
    document.getElementById('sidebar').classList.toggle('open');
}

// ─── USER ──────────────────────────────────────────────────────
async function loadUser() {
    try {
        const data = await apiFetch('/api/dashboard/stats');
        // Use first letter of username for avatar
        const uname = document.cookie.match(/auth_token/) ? '...' : 'U';
        document.getElementById('userAvatar').textContent = uname.charAt(0).toUpperCase();
    } catch(e) {}

    // Get username from server
    try {
        const resp = await fetch('/api/me');
        if (resp.ok) {
            const user = await resp.json();
            document.getElementById('userName').textContent = user.username;
            document.getElementById('userAvatar').textContent = user.username.charAt(0).toUpperCase();
            if (socket) socket.emit('subscribe:reseller', user.id);
        }
    } catch(e) {}
}

// ─── DASHBOARD ────────────────────────────────────────────────
async function loadDashboard() {
    try {
        const data = await apiFetch('/api/dashboard/stats');

        // Metrics
        animateNumber('mLinks', data.links);
        animateNumber('mClicks', data.clicks);
        document.getElementById('mPaid').textContent = '$' + data.paid_usd;
        animateNumber('mPending', data.pending);
        animateNumber('mExpired', data.expired);
        document.getElementById('sPaid7d').textContent = '$' + data.paid_7d;
        document.getElementById('sPaid30d').textContent = '$' + data.paid_30d;
        document.getElementById('sConversion').textContent = data.conversion + '%';

        // Wallet health
        const walletBox = document.getElementById('dashWalletBox');
        const walletBadge = document.getElementById('navWalletBadge');
        const walletDot = document.getElementById('navWalletDot');
        if (data.wallet_status === 'active') {
            walletBox.className = 'wallet-status-box active';
            document.getElementById('dashWalletTitle').textContent = `✅ Wallet Active (${data.wallet_type})`;
            document.getElementById('dashWalletSub').textContent = 'Your wallet is connected and ready to receive payments.';
            walletDot.className = 'status-dot active';
        } else {
            walletBadge.style.display = 'block';
        }

        // Top links table
        const topLinksBody = document.getElementById('topLinksTable');
        if (data.top_links.length) {
            topLinksBody.innerHTML = data.top_links.map(l => `
                <tr>
                  <td><a href="/pay/${l.slug}" target="_blank" class="text-accent">${l.slug}</a></td>
                  <td>${l.fixed_amount ? '$' + l.fixed_amount : 'Open'}</td>
                  <td>${l.clicks}</td>
                  <td>${l.invoices}</td>
                  <td>${statusBadge(l.status)}</td>
                </tr>
            `).join('');
        }

        // Recent payments
        const recentPayBody = document.getElementById('recentPaymentsTable');
        if (data.recent_payments.length) {
            recentPayBody.innerHTML = data.recent_payments.map(p => `
                <tr>
                  <td class="font-mono" style="font-size:11px">${fmtDate(p.created_at)}</td>
                  <td>${p.slug || '—'}</td>
                  <td class="text-green">$${parseFloat(p.total_usd).toFixed(2)}</td>
                  <td>${statusBadge(p.status)}</td>
                </tr>
            `).join('');
        }

        // Recent clicks
        const clicksBody = document.getElementById('recentClicksTable');
        if (data.recent_clicks.length) {
            clicksBody.innerHTML = data.recent_clicks.map(c => `
                <tr>
                  <td class="font-mono" style="font-size:11px">${fmtDate(c.clicked_at)}</td>
                  <td>${c.slug || '—'}</td>
                  <td class="font-mono">${c.ip || '—'}</td>
                  <td>${c.device || '—'}</td>
                </tr>
            `).join('');
        }

    } catch(e) {
        showToast('Failed to load dashboard: ' + e.message, 'error');
    }
}

// ─── WALLET ───────────────────────────────────────────────────
async function loadWallet() {
    try {
        const data = await apiFetch('/api/wallet');
        const box = document.getElementById('walletStatusBox');
        if (data.wallet_type) {
            box.className = 'wallet-status-box active mb-24';
            document.getElementById('walletStatusTitle').textContent = `ACTIVE — ${data.wallet_type.toUpperCase()}`;
            document.getElementById('walletStatusSub').textContent = `Connected. Provider: ${data.wallet_type}`;
            selectProvider(data.wallet_type);

            // Pre-fill fields
            if (data.wallet_email) document.getElementById('walletEmail').value = data.wallet_email;
            if (data.lnbits_url) document.getElementById('lnbitsUrl').value = data.lnbits_url;
            if (data.blink_wallet_id) document.getElementById('blinkWalletId').value = data.blink_wallet_id;
            if (data.opennode_env) document.getElementById('opennodeEnv').value = data.opennode_env;
            if (data.btcpay_url) document.getElementById('btcpayUrl').value = data.btcpay_url;
            if (data.btcpay_store_id) document.getElementById('btcpayStoreId').value = data.btcpay_store_id;

            // Pre-fill Binance & Payout fields
            if (document.getElementById('binanceAutoSweepToggle')) {
                document.getElementById('binanceAutoSweepToggle').checked = data.binance_auto_sweep_enabled;
                document.getElementById('binanceSweepThreshold').value = data.binance_sweep_threshold_usd || 0;
                document.getElementById('binanceSweepType').value = data.binance_sweep_type || 'lightning';
                document.getElementById('autoPayoutToggle').checked = data.auto_payout_enabled;
                if (data.auto_payout_address) document.getElementById('autoPayoutAddress').value = data.auto_payout_address;
                if (data.auto_payout_percent) document.getElementById('autoPayoutPercent').value = data.auto_payout_percent;
                if (document.getElementById('tgChatId') && data.telegram_chat_id) document.getElementById('tgChatId').value = data.telegram_chat_id;
                if (document.getElementById('tgBotToken') && data.telegram_bot_token) document.getElementById('tgBotToken').placeholder = data.telegram_bot_token;
            }
        }
    } catch(e) {}
}

function selectProvider(type) {
    selectedProvider = type;
    document.querySelectorAll('.radio-card').forEach(c => c.classList.remove('selected'));
    const map = {
        lnbits: 'rcLnbits',
        blink: 'rcBlink',
        alby: 'rcAlby',
        email: 'rcEmail',
        opennode: 'rcOpennode',
        btcpay: 'rcBtcpay'
    };
    if (map[type]) {
        const el = document.getElementById(map[type]);
        if (el) el.classList.add('selected');
        const radio = document.getElementById('radio' + type.charAt(0).toUpperCase() + type.slice(1));
        if (radio) radio.checked = true;
    }
}

// LNbits
async function testLnbits(e) {
    e.stopPropagation();
    const url = document.getElementById('lnbitsUrl').value;
    const invoice_key = document.getElementById('lnbitsInvoiceKey').value;
    try {
        const resp = await apiFetch('/api/wallet/lnbits/test', 'POST', { url, invoice_key });
        showToast(`✅ LNbits Connected: ${resp.data.name} (${resp.data.balance_sats.toLocaleString()} sats)`, 'success');
    } catch(err) {
        showToast(err.message, 'error');
    }
}

async function saveLnbits(e) {
    e.stopPropagation();
    const body = {
        url: document.getElementById('lnbitsUrl').value,
        invoice_key: document.getElementById('lnbitsInvoiceKey').value,
        admin_key: document.getElementById('lnbitsAdminKey').value
    };
    try {
        await apiFetch('/api/wallet/lnbits', 'POST', body);
        showToast('LNbits wallet connected successfully!', 'success');
        loadWallet();
    } catch(err) {
        showToast(err.message, 'error');
    }
}

// Blink
async function testBlink(e) {
    e.stopPropagation();
    const api_key = document.getElementById('blinkApiKey').value;
    try {
        const resp = await apiFetch('/api/wallet/blink/test', 'POST', { api_key });
        if (resp.data.wallet_id) document.getElementById('blinkWalletId').value = resp.data.wallet_id;
        showToast(`✅ Blink Connected: ${resp.data.username || 'Wallet'} (${resp.data.balance_sats.toLocaleString()} sats)`, 'success');
    } catch(err) {
        showToast(err.message, 'error');
    }
}

async function saveBlink(e) {
    e.stopPropagation();
    const body = {
        api_key: document.getElementById('blinkApiKey').value,
        wallet_id: document.getElementById('blinkWalletId').value
    };
    try {
        const resp = await apiFetch('/api/wallet/blink', 'POST', body);
        if (resp.data?.wallet_id) document.getElementById('blinkWalletId').value = resp.data.wallet_id;
        showToast('Blink wallet connected successfully!', 'success');
        loadWallet();
    } catch(err) {
        showToast(err.message, 'error');
    }
}

// Alby
async function testAlby(e) {
    e.stopPropagation();
    const access_token = document.getElementById('albyAccessToken').value;
    const nwc_string = document.getElementById('albyNwcString').value;
    try {
        const resp = await apiFetch('/api/wallet/alby/test', 'POST', { access_token, nwc_string });
        showToast(`✅ Alby Connected: ${resp.data.lightning_address || 'Wallet'} (${resp.data.balance_sats} sats)`, 'success');
    } catch(err) {
        showToast(err.message, 'error');
    }
}

async function saveAlby(e) {
    e.stopPropagation();
    const body = {
        access_token: document.getElementById('albyAccessToken').value,
        nwc_string: document.getElementById('albyNwcString').value
    };
    try {
        await apiFetch('/api/wallet/alby', 'POST', body);
        showToast('Alby connected successfully!', 'success');
        loadWallet();
    } catch(err) {
        showToast(err.message, 'error');
    }
}

// Email
async function saveEmailWallet(e) {
    e.stopPropagation();
    const email = document.getElementById('walletEmail').value;
    const btn = e.target;
    btn.disabled = true;
    btn.textContent = 'Saving...';
    try {
        await apiFetch('/api/wallet/email', 'POST', { email });
        showToast('Lightning Address saved!', 'success');
        loadWallet();
    } catch(err) {
        showToast(err.message, 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = 'Save Lightning Address';
    }
}

// OpenNode
async function saveOpennode(e) {
    e.stopPropagation();
    const api_key = document.getElementById('opennodeKey').value;
    const env = document.getElementById('opennodeEnv').value;
    const btn = e.target;
    btn.disabled = true; btn.textContent = 'Connecting...';
    try {
        await apiFetch('/api/wallet/opennode', 'POST', { api_key, env });
        showToast('OpenNode connected!', 'success');
        loadWallet();
    } catch(err) {
        showToast(err.message, 'error');
    } finally {
        btn.disabled = false; btn.textContent = 'Save OpenNode';
    }
}

// BTCPay
async function testBtcpay(e) {
    e.stopPropagation();
    const url = document.getElementById('btcpayUrl').value;
    const store_id = document.getElementById('btcpayStoreId').value;
    const api_key = document.getElementById('btcpayKey').value;
    try {
        const resp = await apiFetch('/api/wallet/btcpay/test', 'POST', { url, store_id, api_key });
        showToast('✅ Connected to store: ' + resp.store, 'success');
    } catch(err) {
        showToast(err.message, 'error');
    }
}

async function saveBtcpay(e) {
    e.stopPropagation();
    const body = {
        url: document.getElementById('btcpayUrl').value,
        store_id: document.getElementById('btcpayStoreId').value,
        api_key: document.getElementById('btcpayKey').value,
        webhook_id: document.getElementById('btcpayWebhookId').value,
        webhook_secret: document.getElementById('btcpayWebhookSecret').value
    };
    try {
        await apiFetch('/api/wallet/btcpay', 'POST', body);
        showToast('BTCPay Server saved!', 'success');
        loadWallet();
    } catch(err) {
        showToast(err.message, 'error');
    }
}

// ─── AUTO-SWEEPS & BINANCE ─────────────────────────────────────
async function loadSweeps() {
    try {
        // Load current wallet/sweep settings
        await loadWallet();

        const data = await apiFetch('/api/sweeps');
        const tbody = document.getElementById('sweepsTableBody');
        const list = data.sweeps || [];
        document.getElementById('sweepTotalCount').textContent = `${list.length} records`;

        if (!list.length) {
            tbody.innerHTML = '<tr><td colspan="7"><div class="empty-state"><div class="empty-icon">🔄</div><div class="empty-text">No sweeps or payouts executed yet</div></div></td></tr>';
            return;
        }

        tbody.innerHTML = list.map(s => {
            const typeBadges = {
                binance_lightning: '<span class="badge badge-green">Binance LN</span>',
                binance_onchain: '<span class="badge badge-yellow">Binance On-Chain</span>',
                instant_ln_payout: '<span class="badge badge-purple">Instant LN Payout</span>'
            };
            const statusBadges = {
                completed: '<span class="badge badge-green">Swept to Binance</span>',
                pending: '<span class="badge badge-yellow">Pending</span>',
                held: '<span class="badge badge-yellow" title="' + (s.error_message || 'Held in wallet') + '">Held in Wallet (Below Min)</span>',
                failed: '<span class="badge badge-red" title="' + (s.error_message || '') + '">Failed</span>'
            };

            const txDisplay = s.preimage || s.txid || (s.error_message ? `<span class="text-sub" style="font-size:11px;" title="${s.error_message}">ℹ️ ${truncate(s.error_message, 28)}</span>` : '—');

            return `
                <tr>
                    <td><span class="text-sub" style="font-size:12px;">${fmtDate(s.created_at)}</span></td>
                    <td>${typeBadges[s.sweep_type] || s.sweep_type}</td>
                    <td><strong>$${parseFloat(s.amount_usd).toFixed(2)}</strong></td>
                    <td><code>${(s.amount_sats || 0).toLocaleString()} sats</code></td>
                    <td><span class="font-mono text-sub">${s.target_destination || 'Binance'}</span></td>
                    <td><span class="font-mono" style="font-size:11px;">${txDisplay}</span></td>
                    <td>${statusBadges[s.status] || s.status}</td>
                </tr>
            `;
        }).join('');
    } catch(err) {
        showToast('Error loading sweeps: ' + err.message, 'error');
    }
}

async function testBinanceConnection() {
    const key = document.getElementById('binanceApiKey').value;
    const secret = document.getElementById('binanceApiSecret').value;
    const out = document.getElementById('binanceTestOutput');
    out.style.display = 'block';
    out.innerHTML = '⏳ Connecting to Binance API...';

    try {
        const resp = await apiFetch('/api/sweeps/test-binance', 'POST', { api_key: key, api_secret: secret });
        out.innerHTML = `
            <div style="color:var(--accent-green);font-weight:600;">✅ Binance API Connected Successfully!</div>
            <div class="mt-4" style="color:var(--text-sub);">Spot BTC Balance: <strong>${resp.data.btc_free} BTC</strong> | USDT: <strong>${resp.data.usdt_free} USDT</strong></div>
        `;
        showToast('Binance API Connected!', 'success');
    } catch(err) {
        out.innerHTML = `<div style="color:var(--accent-red);">❌ ${err.message}</div>`;
        showToast(err.message, 'error');
    }
}

async function saveSweepConfig(e) {
    const btn = (e && e.target) ? e.target : document.querySelector('button[onclick*="saveSweepConfig"]');
    const origText = btn ? btn.textContent : 'Save Binance Settings';
    if (btn) { btn.disabled = true; btn.textContent = 'Saving...'; }

    const body = {
        binance_api_key: document.getElementById('binanceApiKey').value,
        binance_api_secret: document.getElementById('binanceApiSecret').value,
        binance_auto_sweep_enabled: document.getElementById('binanceAutoSweepToggle').checked,
        binance_sweep_threshold_usd: parseFloat(document.getElementById('binanceSweepThreshold').value) || 0,
        binance_sweep_type: document.getElementById('binanceSweepType').value,
        auto_payout_enabled: document.getElementById('autoPayoutToggle').checked,
        auto_payout_address: document.getElementById('autoPayoutAddress').value,
        auto_payout_percent: parseFloat(document.getElementById('autoPayoutPercent').value) || 100
    };

    try {
        const resp = await apiFetch('/api/sweeps/save-config', 'POST', body);
        showToast(resp.message || 'Auto-Sweep settings saved!', 'success');
        if (btn) btn.textContent = '✅ Saved!';
        setTimeout(() => { if (btn) { btn.disabled = false; btn.textContent = origText; } }, 2000);
    } catch(err) {
        showToast(err.message, 'error');
        if (btn) { btn.disabled = false; btn.textContent = origText; }
    }
}

function toggleManualDestInput() {
    const type = document.getElementById('manualSweepType').value;
    const group = document.getElementById('manualDestGroup');
    group.style.display = (type === 'binance') ? 'none' : 'block';
}

async function triggerManualSweep() {
    const destType = document.getElementById('manualSweepType').value;
    const dest = document.getElementById('manualSweepDest').value;
    const amount = document.getElementById('manualSweepAmount').value;

    if (!amount || parseFloat(amount) <= 0) {
        return showToast('Please enter a valid USD amount to sweep', 'warning');
    }

    try {
        const resp = await apiFetch('/api/sweeps/manual', 'POST', {
            destination_type: destType,
            destination_address: dest,
            amount_usd: amount
        });
        showToast(resp.message, 'success');
        document.getElementById('manualSweepAmount').value = '';
        loadSweeps();
    } catch(err) {
        showToast(err.message, 'error');
    }
}

// ─── TELEGRAM NOTIFICATIONS ──────────────────────────────────
async function testTelegramAlert(e) {
    const btn = e ? e.target : null;
    const origText = btn ? btn.textContent : 'Test Telegram Alert';
    if (btn) { btn.disabled = true; btn.textContent = 'Sending...'; }

    const out = document.getElementById('tgTestOutput');
    if (out) { out.style.display = 'block'; out.innerHTML = '⏳ Sending test message to Telegram...'; }

    const bot_token = document.getElementById('tgBotToken').value;
    const chat_id = document.getElementById('tgChatId').value;

    try {
        const resp = await apiFetch('/api/wallet/test-telegram', 'POST', { bot_token, chat_id });
        if (out) {
            out.innerHTML = `<div style="color:var(--accent-green);font-weight:600;">✅ ${resp.message} Check your Telegram app!</div>`;
        }
        showToast('Telegram notification sent!', 'success');
        if (btn) btn.textContent = '✅ Sent!';
        setTimeout(() => { if (btn) { btn.disabled = false; btn.textContent = origText; } }, 2500);
    } catch(err) {
        if (out) {
            out.innerHTML = `<div style="color:var(--accent-red);font-weight:600;">❌ ${err.message}</div>`;
        }
        showToast(err.message, 'error');
        if (btn) { btn.disabled = false; btn.textContent = origText; }
    }
}

async function saveTelegramSettings(e) {
    const btn = e ? e.target : null;
    const origText = btn ? btn.textContent : 'Save Telegram Settings';
    if (btn) { btn.disabled = true; btn.textContent = 'Saving...'; }

    const bot_token = document.getElementById('tgBotToken').value;
    const chat_id = document.getElementById('tgChatId').value;

    try {
        const resp = await apiFetch('/api/wallet/telegram', 'POST', { bot_token, chat_id });
        showToast(resp.message || 'Telegram settings saved!', 'success');
        if (btn) btn.textContent = '✅ Saved!';
        setTimeout(() => { if (btn) { btn.disabled = false; btn.textContent = origText; } }, 2000);
    } catch(err) {
        showToast(err.message, 'error');
        if (btn) { btn.disabled = false; btn.textContent = origText; }
    }
}

// ─── THEMES ───────────────────────────────────────────────────
async function loadThemes(targetGridId = 'themesGrid') {
    try {
        const themes = await apiFetch('/api/themes');
        document.getElementById('themeCount').textContent = themes.length;
        renderThemeGrid(themes, targetGridId);
        if (targetGridId === 'themesGrid') renderThemeGrid(themes, 'createThemeGrid');
    } catch(e) {}
}

function renderThemeGrid(themes, gridId) {
    const grid = document.getElementById(gridId);
    if (!grid) return;
    grid.innerHTML = themes.map(t => `
        <div class="theme-card ${selectedTheme === t.key_name ? 'selected' : ''}" onclick="selectTheme('${t.key_name}', this)">
          <div class="theme-preview" style="background:${t.bg_color || '#0d1117'}">
            <div class="preview-keypad">
              ${[1,2,3,4,5,6,7,8,9].map(n => `<div class="preview-key" style="background:${t.accent_color}22;border:1px solid ${t.accent_color}44">${n}</div>`).join('')}
            </div>
          </div>
          <div class="theme-info">
            <div class="theme-name">${t.name}</div>
            <div class="theme-accent"><span class="accent-dot" style="background:${t.accent_color}"></span>${t.accent_color}</div>
            ${gridId === 'themesGrid' ? `<div class="theme-actions">
              <a class="btn btn-ghost btn-sm" href="/pay/test?theme=${t.key_name}" target="_blank" style="font-size:11px">Open test</a>
              <button class="btn btn-primary btn-sm" onclick="navigate('links')" style="font-size:11px">Create link</button>
            </div>` : ''}
          </div>
        </div>
    `).join('');
}

function selectTheme(key, el) {
    selectedTheme = key;
    document.querySelectorAll('.theme-card').forEach(c => c.classList.remove('selected'));
    document.querySelectorAll(`.theme-card`).forEach(c => {
        if (c.onclick && c.onclick.toString().includes(key)) c.classList.add('selected');
    });
}

// ─── LINKS ────────────────────────────────────────────────────
async function loadLinks() {
    try {
        allLinks = await apiFetch('/api/links');
        renderLinks(allLinks);

        const active = allLinks.filter(l => l.status === 'active').length;
        const clicks = allLinks.reduce((s, l) => s + l.clicks, 0);
        const invoices = allLinks.reduce((s, l) => s + (l.invoice_count || 0), 0);
        document.getElementById('lTotalLinks').textContent = allLinks.length;
        document.getElementById('lActiveLinks').textContent = active;
        document.getElementById('lClicks').textContent = clicks;
        document.getElementById('lInvoices').textContent = invoices;
        loadThemes('createThemeGrid');
    } catch(e) {}
}

function renderLinks(links) {
    const tbody = document.getElementById('linksTable');
    if (!links.length) {
        tbody.innerHTML = '<tr><td colspan="8"><div class="empty-state"><div class="empty-icon">🔗</div><div class="empty-text">No payment links yet</div></div></td></tr>';
        return;
    }
    tbody.innerHTML = links.map(l => `
        <tr>
          <td>
            <a href="/pay/${l.slug}" target="_blank" class="text-accent font-mono">/${l.slug}</a>
            <div style="font-size:11px;color:var(--text-muted)">${l.title}</div>
          </td>
          <td>${l.owner_name || 'Reseller'}</td>
          <td><span class="badge badge-purple">${l.theme}</span></td>
          <td>${l.amount_type === 'fixed' ? '$' + l.fixed_amount : 'Open ($' + l.min_amount + '—$' + l.max_amount + ')'}</td>
          <td>${l.clicks}</td>
          <td>${l.invoice_count || 0}</td>
          <td>${statusBadge(l.status)}</td>
          <td>
            <div class="flex gap-8">
              <button class="btn btn-sm btn-ghost" onclick="copyLink('${l.slug}')" title="Copy">📋</button>
              <button class="btn btn-sm ${l.status === 'active' ? 'btn-outline-red' : 'btn-outline-green'}" onclick="toggleLink(${l.id})">${l.status === 'active' ? 'Disable' : 'Enable'}</button>
              <button class="btn btn-sm btn-danger" onclick="deleteLink(${l.id})">🗑</button>
            </div>
          </td>
        </tr>
    `).join('');
}

function filterLinks() {
    const q = document.getElementById('linksSearch').value.toLowerCase();
    renderLinks(allLinks.filter(l => l.slug.includes(q) || l.title.toLowerCase().includes(q)));
}

function toggleCreateForm() {
    document.getElementById('createLinkForm').classList.toggle('d-none');
}

function previewSlug() {
    const slug = document.getElementById('newSlug').value.toLowerCase().replace(/[^a-z0-9-_]/g, '');
    document.getElementById('slugUrl').textContent = slug ? `${location.origin}/pay/${slug}` : '—';
}

function toggleFixedAmount() {
    const type = document.getElementById('newAmountType').value;
    document.getElementById('amountRangeRow').classList.toggle('d-none', type === 'fixed');
    document.getElementById('fixedAmountRow').classList.toggle('d-none', type !== 'fixed');
}

async function createLink() {
    const formData = new FormData();
    formData.append('slug', document.getElementById('newSlug').value);
    formData.append('title', document.getElementById('newTitle').value);
    formData.append('brand_name', document.getElementById('newBrand').value);
    formData.append('domain', document.getElementById('newDomain').value);
    formData.append('theme', selectedTheme);
    formData.append('amount_type', document.getElementById('newAmountType').value);
    formData.append('min_amount', document.getElementById('newMin').value);
    formData.append('max_amount', document.getElementById('newMax').value);
    if (document.getElementById('newAmountType').value === 'fixed') {
        formData.append('fixed_amount', document.getElementById('newFixed').value);
    }
    const logo = document.getElementById('newLogo').files[0];
    if (logo) formData.append('logo', logo);

    try {
        const resp = await fetch('/api/links', { method: 'POST', body: formData });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error);
        showToast('✅ Payment link created!', 'success');
        toggleCreateForm();
        loadLinks();
    } catch(err) {
        showToast(err.message, 'error');
    }
}

async function toggleLink(id) {
    try {
        const data = await apiFetch(`/api/links/${id}/status`, 'PATCH');
        showToast(`Link ${data.status}`, 'success');
        loadLinks();
    } catch(err) { showToast(err.message, 'error'); }
}

async function deleteLink(id) {
    if (!confirm('Delete this payment link? This cannot be undone.')) return;
    try {
        await apiFetch(`/api/links/${id}`, 'DELETE');
        showToast('Link deleted', 'success');
        loadLinks();
    } catch(err) { showToast(err.message, 'error'); }
}

function copyLink(slug) {
    navigator.clipboard.writeText(`${location.origin}/pay/${slug}`);
    showToast('Link copied!', 'success');
}

// ─── SCAN CODES ───────────────────────────────────────────────
async function loadScanCodes() {
    try {
        const links = await apiFetch('/api/links');
        document.getElementById('scCount').textContent = links.length;
        document.getElementById('scActive').textContent = links.filter(l => l.status === 'active').length;
        document.getElementById('scClicks').textContent = links.reduce((s,l) => s + l.clicks, 0);
        document.getElementById('scInvoices').textContent = links.reduce((s,l) => s + (l.invoice_count||0), 0);

        const grid = document.getElementById('scanCodesGrid');
        if (!links.length) {
            grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1"><div class="empty-icon">📱</div><div class="empty-text">No links yet. Create payment links to generate QR codes.</div></div>';
            return;
        }
        grid.innerHTML = links.map(l => `
            <div class="card" style="text-align:center;position:relative">
              <div class="font-mono text-accent mb-8" style="font-weight:700;font-size:16px">/${l.slug}</div>
              <div class="text-secondary" style="font-size:12px;margin-bottom:14px">${l.title}</div>
              <div style="background:#0d121a;border:1px solid rgba(255,255,255,0.08);border-radius:20px;padding:16px;margin:0 auto 16px;max-width:200px;position:relative;display:flex;align-items:center;justify-content:center">
                <canvas id="qr-${l.id}" width="160" height="160" style="border-radius:8px;display:block;margin:0 auto"></canvas>
                <div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:36px;height:36px;background:var(--accent);border:3px solid #0d121a;border-radius:10px;display:flex;align-items:center;justify-content:center;font-weight:900;color:#041207;font-size:18px;pointer-events:none">$</div>
              </div>
              <div class="flex gap-8 justify-center">
                <button class="btn btn-ghost btn-sm" onclick="copyLink('${l.slug}')">📋 Copy Link</button>
                <a class="btn btn-primary btn-sm" href="/pay/${l.slug}" target="_blank">↗ Open Page</a>
              </div>
            </div>
        `).join('');

        // Generate real QR codes using client QRCode library
        links.forEach(l => {
            const url = `${location.origin}/pay/${l.slug}`;
            generateQRCode(`qr-${l.id}`, url);
        });
    } catch(e) {}
}

function generateQRCode(canvasId, text) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    if (window.QRCode && typeof window.QRCode.toCanvas === 'function') {
        window.QRCode.toCanvas(canvas, text, {
            width: 160,
            margin: 1,
            color: {
                dark: '#ffffff',
                light: '#00000000'
            }
        }, function (err) {
            if (err) console.error(err);
        });
    }
}

// ─── PAYMENTS ─────────────────────────────────────────────────
async function loadPayments() {
    try {
        const status = document.getElementById('pyStatusFilter').value;
        const from = document.getElementById('pyFromDate').value;
        const to = document.getElementById('pyToDate').value;

        let url = '/api/payments?';
        if (status) url += `status=${status}&`;
        if (from) url += `from=${from}&`;
        if (to) url += `to=${to}&`;

        const data = await apiFetch(url);

        // Update status cards
        const pending = data.payments.filter(p => p.status === 'pending').length;
        const paid = data.payments.filter(p => p.status === 'paid').length;
        const failed = data.payments.filter(p => p.status === 'failed').length;
        const expired = data.payments.filter(p => p.status === 'expired').length;
        document.getElementById('pyPending').textContent = pending;
        document.getElementById('pyPaid').textContent = paid;
        document.getElementById('pyFailed').textContent = failed;
        document.getElementById('pyExpired').textContent = expired;

        const tbody = document.getElementById('paymentsTable');
        if (!data.payments.length) {
            tbody.innerHTML = '<tr><td colspan="9"><div class="empty-state"><div class="empty-icon">💳</div><div class="empty-text">No payments found</div></div></td></tr>';
            return;
        }

        tbody.innerHTML = data.payments.map(p => `
            <tr>
              <td class="font-mono" style="font-size:11px">${fmtDate(p.created_at)}</td>
              <td class="text-accent">/${p.slug || '—'}</td>
              <td class="font-mono" style="font-size:11px">${p.payer_ip || '—'}</td>
              <td>$${parseFloat(p.amount_usd).toFixed(2)}</td>
              <td style="color:var(--text-muted)">$${parseFloat(p.charge_usd).toFixed(2)}</td>
              <td class="text-green font-mono">$${parseFloat(p.total_usd).toFixed(2)}</td>
              <td class="font-mono" style="font-size:11px">${p.receiving_wallet ? p.receiving_wallet.substring(0,20)+'...' : '—'}</td>
              <td>${statusBadge(p.status)}</td>
              <td>
                ${!p.seller_checked ? `<button class="btn btn-sm btn-ghost" onclick="checkPayment(${p.id})">✓ Check</button>` : '<span class="badge badge-green">Checked</span>'}
              </td>
            </tr>
        `).join('');
    } catch(e) { showToast(e.message, 'error'); }
}

function filterPaymentStatus(status) {
    document.getElementById('pyStatusFilter').value = status;
    loadPayments();
}

function clearPaymentFilters() {
    document.getElementById('pyStatusFilter').value = '';
    document.getElementById('pyFromDate').value = '';
    document.getElementById('pyToDate').value = '';
    loadPayments();
}

async function checkPayment(id) {
    try {
        await apiFetch(`/api/payments/${id}/check`, 'PATCH');
        loadPayments();
    } catch(e) {}
}

function exportPayments() {
    window.open('/api/payments/export', '_blank');
}

// ─── ACTIVITY ─────────────────────────────────────────────────
async function loadActivity() {
    try {
        const event = document.getElementById('actEventFilter').value;
        const from = document.getElementById('actFrom').value;
        const to = document.getElementById('actTo').value;

        let url = '/api/activities?';
        if (event) url += `event=${event}&`;
        if (from) url += `from=${from}&`;
        if (to) url += `to=${to}&`;

        const activities = await apiFetch(url);
        document.getElementById('activityCount').textContent = activities.length + ' records';

        const timeline = document.getElementById('activityTimeline');
        if (!activities.length) {
            timeline.innerHTML = '<div class="empty-state"><div class="empty-icon">📋</div><div class="empty-text">No activity recorded yet</div></div>';
            return;
        }

        const eventIcons = {
            login: '🔐', password_changed: '🔑', wallet_updated: '⚡',
            link_created: '🔗', logout: '🚪', payment: '💳'
        };

        timeline.innerHTML = activities.map(a => `
            <div class="timeline-item">
              <div class="timeline-dot">${eventIcons[a.event] || '📋'}</div>
              <div class="timeline-content">
                <div class="timeline-event">${a.actor} — ${a.event.replace(/_/g, ' ')}</div>
                <div class="timeline-meta">${fmtDate(a.created_at)} · IP: ${a.ip || '—'} · ${truncate(a.device, 50)}</div>
              </div>
            </div>
        `).join('');
    } catch(e) {}
}

function clearActivityFilters() {
    document.getElementById('actEventFilter').value = '';
    document.getElementById('actFrom').value = '';
    document.getElementById('actTo').value = '';
    loadActivity();
}

// ─── USERS ────────────────────────────────────────────────────
async function loadUsers() {
    try {
        allUsers = await apiFetch('/api/users');
        renderUsers(allUsers);
        document.getElementById('uTotal').textContent = allUsers.length;
        document.getElementById('uActive').textContent = allUsers.filter(u => u.status === 'active').length;
        document.getElementById('uLinks').textContent = allUsers.reduce((s, u) => s + (u.link_count || 0), 0);

        const withdrawals = await apiFetch('/api/users/withdrawals');
        const pending = withdrawals.filter(w => w.status === 'pending').length;
        document.getElementById('uWithdraw').textContent = pending;
        document.getElementById('withdrawCount').textContent = pending + ' pending';
        renderWithdrawals(withdrawals);
    } catch(e) {}
}

function renderUsers(users) {
    document.getElementById('userCount').textContent = users.length + ' accounts';
    const tbody = document.getElementById('usersTable');
    if (!users.length) {
        tbody.innerHTML = '<tr><td colspan="7"><div class="empty-state"><div class="empty-icon">👥</div><div class="empty-text">No users created yet</div></div></td></tr>';
        return;
    }
    tbody.innerHTML = users.map(u => `
        <tr>
          <td>${u.name}</td>
          <td class="text-secondary">${u.email}</td>
          <td>${u.rate_per_dollar}x</td>
          <td>${u.link_count || 0}</td>
          <td class="text-green font-mono">$${parseFloat(u.balance_usd).toFixed(2)}</td>
          <td>${statusBadge(u.status)}</td>
          <td>
            <div class="flex gap-8">
              <button class="btn btn-sm ${u.status === 'active' ? 'btn-outline-red' : 'btn-outline-green'}" onclick="toggleUser(${u.id})">${u.status === 'active' ? 'Suspend' : 'Activate'}</button>
              <button class="btn btn-sm btn-danger" onclick="deleteUser(${u.id})">🗑</button>
            </div>
          </td>
        </tr>
    `).join('');
}

function renderWithdrawals(withdrawals) {
    const tbody = document.getElementById('withdrawalsTable');
    if (!withdrawals.length) {
        tbody.innerHTML = '<tr><td colspan="7"><div class="empty-state"><div class="empty-icon">💸</div><div class="empty-text">No withdrawal requests</div></div></td></tr>';
        return;
    }
    tbody.innerHTML = withdrawals.map(w => `
        <tr>
          <td>${w.name} <span class="text-muted" style="font-size:11px">${w.email}</span></td>
          <td class="font-mono">$${parseFloat(w.amount_usd).toFixed(2)}</td>
          <td>${w.rate}x</td>
          <td class="font-mono text-green">$${parseFloat(w.payout_amount).toFixed(2)}</td>
          <td>${statusBadge(w.status)}</td>
          <td style="font-size:11px">${fmtDate(w.created_at)}</td>
          <td>
            ${w.status === 'pending' ? `
              <div class="flex gap-8">
                <button class="btn btn-sm btn-success" onclick="handleWithdrawal(${w.id},'approved')">✓</button>
                <button class="btn btn-sm btn-danger" onclick="handleWithdrawal(${w.id},'rejected')">✗</button>
              </div>
            ` : '—'}
          </td>
        </tr>
    `).join('');
}

function filterUsers() {
    const q = document.getElementById('userSearch').value.toLowerCase();
    renderUsers(allUsers.filter(u => u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q)));
}

function toggleUserForm() {
    document.getElementById('createUserForm').classList.toggle('d-none');
}

async function createUser() {
    const body = {
        name: document.getElementById('newUserName').value,
        email: document.getElementById('newUserEmail').value,
        password: document.getElementById('newUserPass').value,
        rate_per_dollar: document.getElementById('newUserRate').value,
        charge_mode: document.getElementById('newUserChargeMode').value,
        charge_value: document.getElementById('newUserChargeVal').value
    };
    try {
        await apiFetch('/api/users', 'POST', body);
        showToast('✅ User created!', 'success');
        toggleUserForm();
        loadUsers();
    } catch(err) { showToast(err.message, 'error'); }
}

async function toggleUser(id) {
    try {
        const data = await apiFetch(`/api/users/${id}/status`, 'PATCH');
        showToast(`User ${data.status}`, 'success');
        loadUsers();
    } catch(err) { showToast(err.message, 'error'); }
}

async function deleteUser(id) {
    if (!confirm('Delete this user?')) return;
    try {
        await apiFetch(`/api/users/${id}`, 'DELETE');
        showToast('User deleted', 'success');
        loadUsers();
    } catch(err) { showToast(err.message, 'error'); }
}

async function handleWithdrawal(id, status) {
    try {
        await apiFetch(`/api/users/withdrawals/${id}`, 'PATCH', { status });
        showToast(`Withdrawal ${status}`, 'success');
        loadUsers();
    } catch(err) { showToast(err.message, 'error'); }
}

// ─── SECURITY ─────────────────────────────────────────────────
async function loadSecurity() {
    try {
        const data = await apiFetch('/api/security/status');
        if (data.totp_enabled) {
            document.getElementById('totpInactive').classList.add('d-none');
            document.getElementById('totpEnabled').classList.remove('d-none');
            document.getElementById('totpSetup').classList.add('d-none');
        }

        const log = document.getElementById('securityLog');
        if (data.activity.length) {
            log.innerHTML = data.activity.map(a => `
                <tr>
                  <td class="font-mono" style="font-size:11px">${fmtDate(a.created_at)}</td>
                  <td>${a.event.replace(/_/g,' ')}</td>
                  <td class="font-mono" style="font-size:11px">${a.ip || '—'}</td>
                  <td style="font-size:11px">${truncate(a.device, 40)}</td>
                </tr>
            `).join('');
        }
    } catch(e) {}
}

async function setupTotp() {
    try {
        const data = await apiFetch('/api/security/totp/setup', 'POST');
        document.getElementById('totpInactive').classList.add('d-none');
        document.getElementById('totpSetup').classList.remove('d-none');
        document.getElementById('totpQr').src = data.qr;
        document.getElementById('totpSecret').value = data.secret;
    } catch(err) { showToast(err.message, 'error'); }
}

async function enableTotp() {
    const code = document.getElementById('totpCode').value;
    try {
        await apiFetch('/api/security/totp/enable', 'POST', { code });
        showToast('✅ 2FA enabled!', 'success');
        loadSecurity();
    } catch(err) { showToast(err.message, 'error'); }
}

async function disableTotp() {
    const code = document.getElementById('totpDisableCode').value;
    try {
        await apiFetch('/api/security/totp/disable', 'POST', { code });
        showToast('2FA disabled', 'info');
        document.getElementById('totpEnabled').classList.add('d-none');
        document.getElementById('totpInactive').classList.remove('d-none');
    } catch(err) { showToast(err.message, 'error'); }
}

async function changePassword() {
    const body = {
        new_password: document.getElementById('newPass').value,
        confirm_password: document.getElementById('confirmPass').value
    };
    try {
        await apiFetch('/api/security/password', 'POST', body);
        showToast('✅ Password updated!', 'success');
        document.getElementById('newPass').value = '';
        document.getElementById('confirmPass').value = '';
    } catch(err) { showToast(err.message, 'error'); }
}

// ─── DEVICES ──────────────────────────────────────────────────
async function loadDevices() {
    try {
        const data = await apiFetch('/api/security/devices');
        document.getElementById('devCount').textContent = data.devices.length;

        const current = data.devices.find(d => d.id === data.currentToken);
        if (current) {
            document.getElementById('devCurrent').textContent = current.device_type || 'Desktop';
            document.getElementById('devIp').textContent = current.ip || '—';
        }

        const list = document.getElementById('devicesList');
        list.innerHTML = data.devices.map(d => {
            const isCurrent = d.id === data.currentToken;
            const ua = d.user_agent || '';
            const browser = ua.includes('Chrome') ? 'Chrome' : ua.includes('Firefox') ? 'Firefox' : 'Browser';
            const os = ua.includes('Windows') ? 'Windows' : ua.includes('Mac') ? 'macOS' : ua.includes('Linux') ? 'Linux' : 'Unknown OS';
            return `
                <div class="device-card ${isCurrent ? 'current' : ''}">
                  <div class="device-icon">${d.device_type === 'Mobile' ? '📱' : '💻'}</div>
                  <div class="device-info">
                    <div class="device-name">${browser} on ${os} ${isCurrent ? '<span class="badge badge-green">Current</span>' : '<span class="badge badge-blue">Active</span>'}</div>
                    <div class="device-meta">
                      IP: ${d.ip || '—'} · Last active: ${fmtDate(d.last_active)} · Expires: ${fmtDate(d.expires_at)}
                    </div>
                    <div class="device-meta" style="font-size:10px;margin-top:4px">${truncate(d.user_agent, 60)}</div>
                  </div>
                  ${!isCurrent ? `<button class="btn btn-sm btn-outline-red" onclick="removeDevice('${d.id}')">Remove</button>` : ''}
                </div>
            `;
        }).join('');
    } catch(e) {}
}

async function removeDevice(tokenHash) {
    try {
        await apiFetch(`/api/security/devices/${tokenHash}`, 'DELETE');
        showToast('Device removed', 'success');
        loadDevices();
    } catch(err) { showToast(err.message, 'error'); }
}

async function removeAllDevices() {
    if (!confirm('Remove all other sessions?')) return;
    try {
        await apiFetch('/api/security/devices', 'DELETE');
        showToast('All other devices removed', 'success');
        loadDevices();
    } catch(err) { showToast(err.message, 'error'); }
}

// ─── CHARGE ───────────────────────────────────────────────────
async function loadCharge() {
    try {
        const data = await apiFetch('/api/transaction-charge');
        selectCharge(data.charge_mode);
        if (data.charge_mode === 'fixed') document.getElementById('chargeValueFixed').value = data.charge_value;
        if (data.charge_mode === 'percent') document.getElementById('chargeValuePercent').value = data.charge_value;
        updateChargePreview();
    } catch(e) {}
}

function selectCharge(mode) {
    selectedChargeMode = mode;
    document.querySelectorAll('#page-charge .radio-card').forEach(c => c.classList.remove('selected'));
    const map = { none: 'chargeNone', fixed: 'chargeFixed', percent: 'chargePercent' };
    if (map[mode]) {
        document.getElementById(map[mode]).classList.add('selected');
        document.getElementById('chargeRadio' + mode.charAt(0).toUpperCase() + mode.slice(1)).checked = true;
    }
    updateChargePreview();
}

function updateChargePreview() {
    const base = 100;
    let charge = 0;
    if (selectedChargeMode === 'fixed') charge = parseFloat(document.getElementById('chargeValueFixed').value) || 0;
    if (selectedChargeMode === 'percent') charge = base * (parseFloat(document.getElementById('chargeValuePercent').value) || 0) / 100;
    document.getElementById('chargePreviewAmount').textContent = '$' + charge.toFixed(2);
    document.getElementById('chargePreviewTotal').textContent = '$' + (base + charge).toFixed(2);
}

async function saveCharge() {
    let charge_value = 0;
    if (selectedChargeMode === 'fixed') charge_value = document.getElementById('chargeValueFixed').value;
    if (selectedChargeMode === 'percent') charge_value = document.getElementById('chargeValuePercent').value;
    try {
        await apiFetch('/api/transaction-charge', 'POST', { charge_mode: selectedChargeMode, charge_value });
        showToast('✅ Charge settings saved!', 'success');
    } catch(err) { showToast(err.message, 'error'); }
}

// ─── LOGOUT ───────────────────────────────────────────────────
async function logout() {
    try {
        await fetch('/api/auth/logout', { method: 'POST' });
    } catch(e) {}
    window.location.href = '/login';
}

// ─── MODAL ────────────────────────────────────────────────────
function showModal(title, body, footer = '') {
    document.getElementById('modalTitle').textContent = title;
    document.getElementById('modalBody').innerHTML = body;
    document.getElementById('modalFooter').innerHTML = footer;
    document.getElementById('modalOverlay').classList.add('open');
}
function closeModal(e) {
    if (!e || e.target.id === 'modalOverlay') {
        document.getElementById('modalOverlay').classList.remove('open');
    }
}

// ─── TOAST ────────────────────────────────────────────────────
function showToast(message, type = 'info') {
    let container = document.getElementById('toastContainer');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toastContainer';
        container.className = 'toast-container';
        document.body.appendChild(container);
    }
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    const icons = { success: '✅', error: '❌', info: 'ℹ️', warning: '⚠️' };
    toast.innerHTML = `<span>${icons[type] || '•'}</span><span>${message}</span>`;
    container.appendChild(toast);
    setTimeout(() => {
        toast.style.animation = 'slideOut 0.3s ease forwards';
        setTimeout(() => toast.remove(), 300);
    }, 3500);
}

// ─── UTILS ────────────────────────────────────────────────────
async function apiFetch(url, method = 'GET', body = null) {
    const opts = {
        method,
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include'
    };
    if (body) opts.body = JSON.stringify(body);
    const resp = await fetch(url, opts);
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Request failed');
    return data;
}

function fmtDate(d) {
    if (!d) return '—';
    try {
        const normalized = typeof d === 'string' ? d.replace(' ', 'T') + (d.includes('Z') ? '' : 'Z') : d;
        const date = new Date(normalized);
        if (isNaN(date.getTime())) {
            const fallback = new Date(d);
            if (!isNaN(fallback.getTime())) return fallback.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
            return d;
        }
        return date.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch(e) {
        return d;
    }
}

function truncate(str, n) {
    if (!str) return '—';
    return str.length > n ? str.substring(0, n) + '…' : str;
}

function statusBadge(status) {
    const map = {
        active: 'badge-green', inactive: 'badge-grey', pending: 'badge-yellow',
        paid: 'badge-green', failed: 'badge-red', expired: 'badge-grey',
        suspended: 'badge-red', approved: 'badge-green', rejected: 'badge-red'
    };
    return `<span class="badge ${map[status] || 'badge-grey'}">${status}</span>`;
}

function animateNumber(id, target) {
    const el = document.getElementById(id);
    if (!el) return;
    const start = parseInt(el.textContent) || 0;
    const diff = target - start;
    const duration = 600;
    const startTime = Date.now();
    const tick = () => {
        const elapsed = Date.now() - startTime;
        const progress = Math.min(elapsed / duration, 1);
        const eased = 1 - Math.pow(1 - progress, 3);
        el.textContent = Math.round(start + diff * eased);
        if (progress < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
}

// ─── ANALYTICS PAGE ───────────────────────────────────────────
async function loadAnalytics() {
    const el = document.getElementById('page-analytics');
    if (!el) return;

    el.innerHTML = `
    <div class="page-header"><h2>📈 Analytics & Revenue</h2></div>
    <div id="analyticsContent"><div class="loading-spinner"></div></div>`;

    try {
        const [overview, chart, topLinks] = await Promise.all([
            apiFetch('/api/analytics/overview'),
            apiFetch('/api/analytics/chart?period=30'),
            apiFetch('/api/analytics/top-links')
        ]);

        el.innerHTML = `
        <div class="page-header">
            <h2>📈 Analytics & Revenue</h2>
            <div style="display:flex;gap:8px;">
                <button class="btn btn-sm btn-ghost" onclick="loadChartData(7)">7D</button>
                <button class="btn btn-sm btn-primary" id="btn30d" onclick="loadChartData(30)">30D</button>
                <button class="btn btn-sm btn-ghost" onclick="loadChartData(90)">90D</button>
            </div>
        </div>

        <!-- KPI Cards -->
        <div class="stats-grid" style="grid-template-columns:repeat(auto-fit,minmax(160px,1fr));margin-bottom:24px;">
            <div class="stat-card">
                <div class="stat-label">Total Revenue</div>
                <div class="stat-value" style="color:#00d632;">$${overview.total_revenue}</div>
                <div class="stat-sub">${overview.total_paid} paid orders</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">Today</div>
                <div class="stat-value">$${overview.today.revenue}</div>
                <div class="stat-sub">${overview.today.count} payments</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">This Week</div>
                <div class="stat-value">$${overview.week.revenue}</div>
                <div class="stat-sub" style="color:${overview.week.growth >= 0 ? '#00d632' : '#ff4757'};">
                    ${overview.week.growth >= 0 ? '▲' : '▼'} ${Math.abs(overview.week.growth)}% vs last week
                </div>
            </div>
            <div class="stat-card">
                <div class="stat-label">This Month</div>
                <div class="stat-value">$${overview.month.revenue}</div>
                <div class="stat-sub">${overview.month.count} payments</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">Avg Order</div>
                <div class="stat-value">$${overview.avg_order}</div>
                <div class="stat-sub">${overview.total_invoices} total invoices</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">Auto-Swept</div>
                <div class="stat-value" style="color:#00d632;">$${overview.sweeps.swept_usd}</div>
                <div class="stat-sub">${overview.sweeps.swept} swept · ${overview.sweeps.held} held</div>
            </div>
        </div>

        <!-- Revenue Chart -->
        <div class="card" style="margin-bottom:24px;">
            <div class="card-header"><h3 class="card-title">📊 Daily Revenue (30 Days)</h3></div>
            <div class="card-body" style="padding:16px;">
                <canvas id="revenueChart" height="100"></canvas>
            </div>
        </div>

        <!-- Top Links Table -->
        <div class="card">
            <div class="card-header"><h3 class="card-title">🔗 Top Payment Links</h3></div>
            <div class="card-body" style="padding:0;">
                <table class="data-table">
                    <thead><tr><th>Link</th><th>Payments</th><th>Revenue</th><th>Last Payment</th></tr></thead>
                    <tbody>
                        ${topLinks.length ? topLinks.map(l => `
                            <tr>
                                <td><strong>${l.title || l.slug}</strong><br><small style="color:#6e7681;">/pay/${l.slug}</small></td>
                                <td>${l.payment_count}</td>
                                <td style="color:#00d632;font-weight:700;">$${l.total_revenue}</td>
                                <td>${fmtDate(l.last_payment)}</td>
                            </tr>`).join('') : '<tr><td colspan="4" style="text-align:center;color:#6e7681;padding:24px;">No data yet</td></tr>'}
                    </tbody>
                </table>
            </div>
        </div>`;

        // Draw chart using Chart.js (load dynamically)
        renderRevenueChart(chart);

    } catch (e) {
        document.getElementById('analyticsContent').innerHTML = `<div class="alert alert-error">Failed to load analytics: ${e.message}</div>`;
    }
}

function renderRevenueChart(data) {
    if (!window.Chart) {
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js';
        s.onload = () => drawChart(data);
        document.head.appendChild(s);
    } else {
        drawChart(data);
    }
}

function drawChart(data) {
    const ctx = document.getElementById('revenueChart');
    if (!ctx) return;
    if (window._revenueChart) window._revenueChart.destroy();

    window._revenueChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: data.labels.map(d => {
                const dt = new Date(d);
                return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            }),
            datasets: [{
                label: 'Revenue ($)',
                data: data.revenues,
                backgroundColor: 'rgba(0, 214, 50, 0.25)',
                borderColor: '#00d632',
                borderWidth: 2,
                borderRadius: 6,
                hoverBackgroundColor: 'rgba(0, 214, 50, 0.5)'
            }]
        },
        options: {
            responsive: true,
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: ctx => `$${ctx.parsed.y.toFixed(2)}`
                    }
                }
            },
            scales: {
                x: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#6e7681', maxTicksLimit: 10 } },
                y: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#6e7681', callback: v => '$' + v } }
            }
        }
    });
}

async function loadChartData(days) {
    try {
        const chart = await apiFetch(`/api/analytics/chart?period=${days}`);
        drawChart(chart);
    } catch(e) {}
}

// ─── 2FA PAGE ─────────────────────────────────────────────────
async function load2FA() {
    const el = document.getElementById('page-twofa');
    if (!el) return;

    el.innerHTML = `<div class="page-header"><h2>🔑 Two-Factor Authentication (2FA)</h2></div><div id="twofaContent"><div class="loading-spinner"></div></div>`;

    try {
        const status = await apiFetch('/api/2fa/status');
        render2FAPage(status.enabled);
    } catch(e) {
        document.getElementById('twofaContent').innerHTML = `<div class="alert alert-error">Failed to load 2FA status</div>`;
    }
}

function render2FAPage(enabled) {
    const content = document.getElementById('twofaContent');
    if (!content) return;

    if (enabled) {
        content.innerHTML = `
        <div class="card" style="max-width:500px;">
            <div class="card-header">
                <h3 class="card-title">🟢 2FA is Active</h3>
            </div>
            <div class="card-body">
                <p style="color:#8b949e;margin-bottom:20px;">Your account is protected with Google Authenticator. A 6-digit code is required every time you log in.</p>
                <div class="alert" style="background:rgba(0,214,50,0.08);border:1px solid rgba(0,214,50,0.2);color:#00d632;padding:12px;border-radius:10px;margin-bottom:20px;">
                    ✅ Two-factor authentication is <strong>enabled</strong>
                </div>
                <hr style="border-color:rgba(255,255,255,0.06);margin:20px 0;">
                <p style="font-size:13px;color:#6e7681;margin-bottom:12px;">To disable 2FA, enter your current authenticator code:</p>
                <div class="form-group" style="margin-bottom:12px;">
                    <input id="disableTotpCode" class="input" placeholder="6-digit code" maxlength="6" style="letter-spacing:6px;font-size:20px;text-align:center;">
                </div>
                <button class="btn btn-danger" style="width:100%;" onclick="disable2FA()">🔓 Disable 2FA</button>
            </div>
        </div>`;
    } else {
        content.innerHTML = `
        <div class="card" style="max-width:500px;">
            <div class="card-header">
                <h3 class="card-title">🔑 Enable Two-Factor Authentication</h3>
            </div>
            <div class="card-body">
                <p style="color:#8b949e;margin-bottom:20px;">Protect your account with Google Authenticator. You'll need to enter a 6-digit code each time you log in.</p>
                <div class="alert" style="background:rgba(255,70,70,0.08);border:1px solid rgba(255,70,70,0.2);color:#ff6b6b;padding:12px;border-radius:10px;margin-bottom:20px;">
                    ⚠️ 2FA is currently <strong>disabled</strong>. Your account is less secure.
                </div>
                <button class="btn btn-primary" style="width:100%;margin-bottom:16px;" onclick="setup2FA()">⚡ Set Up 2FA Now</button>
                <div id="qrSetupArea" style="display:none;">
                    <hr style="border-color:rgba(255,255,255,0.06);margin:20px 0;">
                    <p style="font-size:13px;color:#8b949e;margin-bottom:12px;">1️⃣ Scan this QR code with <strong>Google Authenticator</strong>:</p>
                    <div style="text-align:center;margin-bottom:16px;">
                        <img id="qrCodeImg" src="" style="width:200px;height:200px;border-radius:12px;background:#fff;padding:8px;" alt="2FA QR Code">
                    </div>
                    <p style="font-size:13px;color:#8b949e;margin-bottom:4px;">Or enter this secret manually:</p>
                    <code id="totpSecret" style="display:block;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:8px;padding:10px;font-size:13px;text-align:center;letter-spacing:2px;word-break:break-all;margin-bottom:16px;"></code>
                    <p style="font-size:13px;color:#8b949e;margin-bottom:12px;">2️⃣ Enter the 6-digit code from the app to confirm:</p>
                    <div class="form-group" style="margin-bottom:12px;">
                        <input id="verifyTotpCode" class="input" placeholder="6-digit code" maxlength="6" style="letter-spacing:6px;font-size:20px;text-align:center;">
                    </div>
                    <button class="btn btn-primary" style="width:100%;" onclick="verify2FA()">✅ Activate 2FA</button>
                </div>
            </div>
        </div>`;
    }
}

async function setup2FA() {
    try {
        const data = await apiFetch('/api/2fa/setup');
        document.getElementById('qrSetupArea').style.display = 'block';
        document.getElementById('qrCodeImg').src = data.qr_code;
        document.getElementById('totpSecret').textContent = data.secret;
    } catch(e) {
        showToast(e.message, 'error');
    }
}

async function verify2FA() {
    const code = document.getElementById('verifyTotpCode')?.value?.trim();
    if (!code || code.length !== 6) return showToast('Enter a valid 6-digit code', 'error');
    try {
        await apiFetch('/api/2fa/verify', 'POST', { code });
        showToast('✅ 2FA enabled! Your account is now protected.', 'success');
        setTimeout(() => load2FA(), 1200);
    } catch(e) {
        showToast(e.message, 'error');
    }
}

async function disable2FA() {
    const code = document.getElementById('disableTotpCode')?.value?.trim();
    if (!code || code.length !== 6) return showToast('Enter your current 6-digit code', 'error');
    try {
        await apiFetch('/api/2fa/disable', 'POST', { code });
        showToast('2FA disabled.', 'info');
        setTimeout(() => load2FA(), 1200);
    } catch(e) {
        showToast(e.message, 'error');
    }
}

