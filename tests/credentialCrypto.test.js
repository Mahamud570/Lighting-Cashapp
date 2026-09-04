describe('credential encryption compatibility layer', () => {
    const original = process.env.CREDENTIAL_ENCRYPTION_KEY;
    afterEach(() => {
        if (original === undefined) delete process.env.CREDENTIAL_ENCRYPTION_KEY;
        else process.env.CREDENTIAL_ENCRYPTION_KEY = original;
        jest.resetModules();
    });

    test('leaves existing plaintext untouched until a key is activated', () => {
        delete process.env.CREDENTIAL_ENCRYPTION_KEY;
        const crypto = require('../utils/credentialCrypto');
        expect(crypto.encrypt('existing-secret')).toBe('existing-secret');
        expect(crypto.decrypt('existing-secret')).toBe('existing-secret');
    });

    test('round trips AES-256-GCM ciphertext without exposing plaintext', () => {
        process.env.CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
        const crypto = require('../utils/credentialCrypto');
        const encrypted = crypto.encrypt('provider-secret');
        expect(encrypted).toMatch(/^enc:v1:/);
        expect(encrypted).not.toContain('provider-secret');
        expect(crypto.decrypt(encrypted)).toBe('provider-secret');
    });

    test('rejects an invalid encryption key', () => {
        process.env.CREDENTIAL_ENCRYPTION_KEY = 'too-short';
        const crypto = require('../utils/credentialCrypto');
        expect(() => crypto.encrypt('provider-secret')).toThrow(/exactly 32 bytes/);
    });
});
