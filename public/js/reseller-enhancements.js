(() => {
  'use strict';

  const escapeHtml = (value) => {
    if (typeof window.escHtml === 'function') return window.escHtml(value);
    return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  };
  const formatDate = (value) => typeof window.fmtDate === 'function' ? window.fmtDate(value) : (value ? new Date(String(value).replace(' ','T') + 'Z').toLocaleString() : '—');
  const toast = (msg, type='info') => typeof window.showToast === 'function' ? window.showToast(msg, type) : console.log(msg);

  function browserInfo(ua='') {
    const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
    const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'Device';
    return `${browser} on ${os}`;
  }

  function installSidebarBackdrop() {
    if (document.getElementById('sidebarBackdrop')) return;
    const backdrop = document.createElement('div');
    backdrop.id = 'sidebarBackdrop';
    backdrop.className = 'sidebar-backdrop';
    backdrop.addEventListener('click', () => {
      document.getElementById('sidebar')?.classList.remove('open');
      backdrop.classList.remove('open');
    });
    document.body.appendChild(backdrop);

    const originalToggle = window.toggleSidebar;
    window.toggleSidebar = function() {
      if (typeof originalToggle === 'function') originalToggle();
      const open = document.getElementById('sidebar')?.classList.contains('open');
      backdrop.classList.toggle('open', !!open);
    };

    document.querySelectorAll('.nav-item[data-page]').forEach(el => el.addEventListener('click', () => backdrop.classList.remove('open')));
  }

  function compactWalletLanguage() {
    const sidebarWallet = document.querySelector('.nav-item[data-page="wallet"]');
    if (sidebarWallet) {
      [...sidebarWallet.childNodes].forEach(n => { if (n.nodeType === 3 && n.textContent.trim()) n.textContent = ' Wallet '; });
    }
    const sidebarSweeps = document.querySelector('.nav-item[data-page="sweeps"]');
    if (sidebarSweeps) {
      [...sidebarSweeps.childNodes].forEach(n => { if (n.nodeType === 3 && n.textContent.trim()) n.textContent = ' Settlement '; });
    }

    const walletPage = document.getElementById('page-wallet');
    if (!walletPage) return;
    const title = walletPage.querySelector('.page-title');
    const sub = walletPage.querySelector('.page-sub');
    if (title) title.textContent = '⚡ Wallet Connection';
    if (sub) sub.textContent = 'Choose and configure your wallet connection.';

    const configs = {
      rcLnbits: { title:'⚡ LNB', badge:'Type A', sub:'Wallet connection A.', labels:['Endpoint','Key A','Key B'], hints:['',''] },
      rcBlink: { title:'⚡ LNP', badge:'Type B', sub:'Wallet connection B.', labels:['Primary Key','Wallet ID','Key Pool'] },
      rcAlby: { title:'🐝 ALB / NWC', badge:'Type C', sub:'Wallet connection C.', labels:['Access Key','Connection Key (Optional)'] },
      rcEmail: { title:'⚡ LNA', badge:'Type D', sub:'Direct wallet address.', labels:['Wallet Address'] },
      rcOpennode: { title:'🔶 OPN', badge:'Type E', sub:'Wallet connection E.', labels:['Access Key','Mode'] },
      rcBtcpay: { title:'🟠 BTP', badge:'Type F', sub:'Wallet connection F.', labels:['Endpoint','Store ID','Access Key','Hook ID (Optional)','Hook Secret (Optional)'] }
    };

    Object.entries(configs).forEach(([id,cfg]) => {
      const card = document.getElementById(id);
      if (!card) return;
      const rcTitle = card.querySelector('.rc-title');
      const rcSub = card.querySelector('.rc-sub');
      if (rcTitle) rcTitle.innerHTML = `${cfg.title} <span class="badge badge-green" style="margin-left:8px">${cfg.badge}</span>`;
      if (rcSub) rcSub.textContent = cfg.sub;
      const labels = card.querySelectorAll('.form-label');
      cfg.labels.forEach((text, i) => { if (labels[i]) labels[i].textContent = text; });
      card.querySelectorAll('.form-hint').forEach(h => { h.textContent = 'Configuration value supplied by your wallet provider.'; });
    });

    const placeholders = {
      lnbitsUrl:'https://wallet.example', lnbitsInvoiceKey:'key_a', lnbitsAdminKey:'key_b',
      blinkApiKey:'primary_key', blinkWalletId:'wallet_id', blinkApiKeys:'one key per line',
      albyAccessToken:'access_key', albyNwcString:'connection_key', walletEmail:'name@wallet',
      opennodeKey:'access_key', btcpayUrl:'https://wallet.example', btcpayStoreId:'store_id',
      btcpayKey:'access_key', btcpayWebhookId:'hook_id', btcpayWebhookSecret:'hook_secret'
    };
    Object.entries(placeholders).forEach(([id,value]) => { const el=document.getElementById(id); if(el) el.placeholder=value; });
  }

  function addSupportCard() {
    if (document.getElementById('resellerSupportCard')) return;
    const content = document.querySelector('.content');
    if (!content) return;
    const card = document.createElement('div');
    card.id = 'resellerSupportCard';
    card.className = 'reseller-support-card';
    card.innerHTML = `
      <div class="support-copy">
        <div class="support-title">Need Support?</div>
        <div class="support-sub">Contact developer support directly on Telegram.</div>
      </div>
      <a class="support-button" href="https://t.me/DEV_IMP4sTER" target="_blank" rel="noopener noreferrer" aria-label="Telegram support @DEV_IMP4sTER">
        <span class="tg-icon">✈</span><span>@DEV_IMP4sTER</span>
      </a>`;
    content.appendChild(card);
  }

  function buildDevicePage() {
    const page = document.getElementById('page-devices');
    if (!page || page.dataset.enhancedSessions === '1') return page;
    page.dataset.enhancedSessions = '1';
    page.innerHTML = `
      <div class="page-header">
        <div><div class="page-title">🖥 Sessions & Browsers</div><div class="page-sub">Manage active logins and browsers saved for 2FA.</div></div>
        <button class="btn btn-ghost btn-sm" onclick="loadDevices()">⟳ Refresh</button>
      </div>
      <div class="card session-section">
        <div class="session-toolbar"><div><strong>Active Sessions</strong><div class="tech-short-note">Browser sessions stay active until logout or expiry.</div></div><button class="btn btn-sm btn-outline-red" onclick="removeAllSessions()">Log out all others</button></div>
        <div class="session-grid" id="activeSessionsGrid"><div class="text-muted">Loading sessions…</div></div>
      </div>
      <div class="card session-section">
        <div class="session-toolbar"><div><strong>Saved Browsers</strong><div class="tech-short-note">Saved browsers can skip 2FA for up to 30 days.</div></div><button class="btn btn-sm btn-outline-red" onclick="removeAllTrustedBrowsers()">Remove all saved</button></div>
        <div class="session-grid" id="trustedBrowsersGrid"><div class="text-muted">Loading saved browsers…</div></div>
      </div>`;
    return page;
  }

  window.loadDevices = async function() {
    buildDevicePage();
    try {
      const [sessionData, trustData] = await Promise.all([
        window.apiFetch('/api/security/sessions'),
        window.apiFetch('/api/security/trusted-browsers')
      ]);
      const sessionsGrid = document.getElementById('activeSessionsGrid');
      const trustedGrid = document.getElementById('trustedBrowsersGrid');

      if (sessionsGrid) {
        sessionsGrid.innerHTML = sessionData.sessions.length ? sessionData.sessions.map(s => {
          const current = Number(s.id) === Number(sessionData.current_session_id);
          return `<div class="session-card ${current ? 'current' : ''}">
            <div class="session-icon">${s.device_type === 'Mobile' ? '📱' : '💻'}</div>
            <div class="session-body"><div class="session-name">${escapeHtml(browserInfo(s.user_agent))} ${current ? '<span class="badge badge-green">Current</span>' : '<span class="badge badge-blue">Active</span>'}</div>
              <div class="session-meta">IP: ${escapeHtml(s.ip || '—')} · Last active: ${escapeHtml(formatDate(s.last_active))}</div>
              <div class="session-meta">Signed in: ${escapeHtml(formatDate(s.created_at))} · Expires: ${escapeHtml(formatDate(s.expires_at))}</div></div>
            <div class="session-actions">${current ? '' : `<button class="btn btn-sm btn-outline-red" onclick="removeSession(${Number(s.id)})">Log out</button>`}</div>
          </div>`;
        }).join('') : '<div class="text-muted">No active sessions.</div>';
      }

      if (trustedGrid) {
        trustedGrid.innerHTML = trustData.devices.length ? trustData.devices.map(d => `<div class="session-card trusted">
          <div class="session-icon">${d.device_type === 'Mobile' ? '📱' : '💻'}</div>
          <div class="session-body"><div class="session-name">${escapeHtml(d.label || browserInfo(d.user_agent))} <span class="badge badge-purple">2FA Saved</span></div>
            <div class="session-meta">IP: ${escapeHtml(d.ip || '—')} · Last used: ${escapeHtml(formatDate(d.last_used))}</div>
            <div class="session-meta">Saved: ${escapeHtml(formatDate(d.created_at))} · Expires: ${escapeHtml(formatDate(d.expires_at))}</div></div>
          <div class="session-actions"><button class="btn btn-sm btn-outline-red" onclick="removeTrustedBrowser(${Number(d.id)})">Remove</button></div>
        </div>`).join('') : '<div class="text-muted">No saved browsers. On your next 2FA login, select “Trust this browser”.</div>';
      }
    } catch (err) {
      toast('Failed to load browser sessions: ' + err.message, 'error');
    }
  };

  window.removeSession = async function(id) {
    try { await window.apiFetch(`/api/security/sessions/${id}`, 'DELETE'); toast('Session logged out', 'success'); await window.loadDevices(); }
    catch (err) { toast(err.message, 'error'); }
  };
  window.removeAllSessions = async function() {
    if (!confirm('Log out every other browser session?')) return;
    try { await window.apiFetch('/api/security/sessions', 'DELETE'); toast('Other sessions logged out', 'success'); await window.loadDevices(); }
    catch (err) { toast(err.message, 'error'); }
  };
  window.removeTrustedBrowser = async function(id) {
    try { await window.apiFetch(`/api/security/trusted-browsers/${id}`, 'DELETE'); toast('Saved browser removed', 'success'); await window.loadDevices(); }
    catch (err) { toast(err.message, 'error'); }
  };
  window.removeAllTrustedBrowsers = async function() {
    if (!confirm('Remove all saved browsers? 2FA will be required again on every browser.')) return;
    try { await window.apiFetch('/api/security/trusted-browsers', 'DELETE'); toast('All saved browsers removed', 'success'); await window.loadDevices(); }
    catch (err) { toast(err.message, 'error'); }
  };

  // Preserve the secure backend policy while keeping the current UI functional.
  window.disableTotp = async function() {
    const code = document.getElementById('totpDisableCode')?.value || document.getElementById('disableTotpCode')?.value || '';
    const currentPassword = prompt('Enter your current password to disable 2FA:');
    if (!currentPassword) return;
    try {
      await window.apiFetch('/api/security/totp/disable', 'POST', { code, current_password: currentPassword });
      toast('2FA disabled', 'info');
      document.getElementById('totpEnabled')?.classList.add('d-none');
      document.getElementById('totpInactive')?.classList.remove('d-none');
    } catch (err) { toast(err.message, 'error'); }
  };

  document.addEventListener('DOMContentLoaded', () => {
    installSidebarBackdrop();
    compactWalletLanguage();
    addSupportCard();
    buildDevicePage();
  });
})();
