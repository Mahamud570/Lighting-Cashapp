const { redactText, safeErrorDetails } = require('../../../utils/safeError');

describe('safe error redaction', () => {
    test.each([
        ['API key: sk_live_secret', 'sk_live_secret'],
        ['api_secret=super-secret', 'super-secret'],
        ['password: hunter2', 'hunter2'],
        ['access_token=token-value', 'token-value'],
        ['x-api-key: abc123', 'abc123']
    ])('redacts labeled credentials from %s', (message, secret) => {
        const redacted = redactText(message);
        expect(redacted).not.toContain(secret);
        expect(redacted).toContain('[redacted]');
    });

    test('redacts provider error messages before logging', () => {
        const details = safeErrorDetails({
            response: { status: 403, data: { detail: 'API key: provider-secret' } }
        });
        expect(details.status).toBe(403);
        expect(details.message).not.toContain('provider-secret');
    });
});
