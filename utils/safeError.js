const SENSITIVE_FIELDS = /(?:api[-_ ]?key|api[-_ ]?secret|authorization|token|password|cookie|bolt11|invoice|preimage|signature|seed)/i;

function redactText(value) {
    return String(value ?? '')
        .replace(/((?:api[-_ ]?(?:key|secret)|password|access[-_ ]?token|refresh[-_ ]?token|cookie|preimage|seed)\s*[:=]\s*)[^\s,; }\]]+/gi, '$1[redacted]')
        .replace(/(x-api-key\s*[:=]\s*)[^\s,}\]]+/gi, '$1[redacted]')
        .replace(/(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s,}\]]+/gi, '$1[redacted]')
        .replace(/([?&](?:apiKey|api_key|apiSecret|api_secret|signature|token)=)[^&\s]+/gi, '$1[redacted]')
        .replace(/((?:pubKey|clientEnv)\s*[:=]\s*)[^\s,; }\]]+/gi, '$1[redacted]')
        .replace(/\b(?:lnbc|lntb|lnbcrt)[0-9a-z]+\b/gi, '[redacted-lightning-invoice]');
}

function safeErrorDetails(err) {
    const response = err?.response;
    const providerMessage = response?.data?.detail || response?.data?.msg || response?.data?.message;
    return {
        name: redactText(err?.name || 'Error'),
        message: redactText(providerMessage || err?.message || String(err || 'Unknown error')),
        code: err?.code || response?.data?.code || undefined,
        status: Number.isInteger(response?.status) ? response.status : (Number.isInteger(err?.status) ? err.status : undefined)
    };
}

function logSafeError(label, err) {
    console.error(label, safeErrorDetails(err));
}

module.exports = { redactText, safeErrorDetails, logSafeError };
