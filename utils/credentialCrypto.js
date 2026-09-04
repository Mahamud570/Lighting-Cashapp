const crypto = require('crypto');
const PREFIX = 'enc:v1:';

function loadKey() {
    const raw = String(process.env.CREDENTIAL_ENCRYPTION_KEY || '').trim();
    if (!raw) return null;
    const key = /^[a-f0-9]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
    if (key.length !== 32) throw new Error('CREDENTIAL_ENCRYPTION_KEY must decode to exactly 32 bytes');
    return key;
}
function isEncrypted(value) { return typeof value === 'string' && value.startsWith(PREFIX); }
function encrypt(value) {
    if (value === null || value === undefined || value === '' || isEncrypted(value)) return value;
    const key = loadKey();
    if (!key) return value; // Compatibility mode until owner explicitly activates encryption.
    const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
    return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}
function decrypt(value) {
    if (!isEncrypted(value)) return value;
    const key = loadKey(); if (!key) throw new Error('Encrypted credential cannot be read without CREDENTIAL_ENCRYPTION_KEY');
    const payload = Buffer.from(value.slice(PREFIX.length), 'base64');
    if (payload.length < 29) throw new Error('Encrypted credential payload is invalid');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, payload.subarray(0, 12));
    decipher.setAuthTag(payload.subarray(12, 28));
    return Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt, isEncrypted, hasKey: () => Boolean(loadKey()) };
