function isMaskedSecret(value) {
    if (typeof value !== 'string') return false;
    const v = value.trim();
    return /^(?:\*{3,}|•{3,})/.test(v) || v === 'nostr+walletconnect://***';
}

function resolveStoredSecret(value, storedValue) {
    if (value === undefined || value === null || value === '' || isMaskedSecret(value)) return storedValue || null;
    return String(value).trim();
}

function maskSecret(value, suffix = 4) {
    return value ? `***${String(value).slice(-suffix)}` : null;
}

module.exports = { isMaskedSecret, resolveStoredSecret, maskSecret };
