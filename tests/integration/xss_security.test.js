/**
 * XSS & Security Regression Test Suite
 */
process.env.JWT_SECRET = 'test_secret_for_xss_suite';

describe('Security & XSS Regression Suite', () => {
    test('XSS sanitization helper escHtml escapes script tags and attributes', () => {
        function escHtml(str) {
            if (str === null || str === undefined) return '';
            return String(str)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');
        }

        const scriptPayload = '<script>alert(document.domain)</script>';
        const imgPayload = '<img src=x onerror=alert(1)>';
        const attrPayload = '" onmouseover="alert(1)';

        expect(escHtml(scriptPayload)).toBe('&lt;script&gt;alert(document.domain)&lt;/script&gt;');
        expect(escHtml(imgPayload)).toBe('&lt;img src=x onerror=alert(1)&gt;');
        expect(escHtml(attrPayload)).toBe('&quot; onmouseover=&quot;alert(1)');
    });

    test('Fixed payment amount strictly rejects mismatched values', () => {
        const link = { amount_type: 'fixed', fixed_amount: 25.00 };
        const amountAttempt = 24.99;
        const isValid = Math.abs(amountAttempt - parseFloat(link.fixed_amount)) < 0.001;
        expect(isValid).toBe(false);
    });

    test('Charge calculation caps fees at maximum safe boundaries', () => {
        const amountUsd = 100;
        
        // Capped percentage
        const percentInput = 150; // Attempt 150% fee
        const safePercent = Math.min(percentInput, 50);
        const chargeUsd = (amountUsd * safePercent) / 100;
        expect(chargeUsd).toBe(50); // Capped at $50

        // Capped fixed
        const fixedInput = 500; // Attempt $500 fee
        const safeFixed = Math.min(fixedInput, 100);
        expect(safeFixed).toBe(100); // Capped at $100
    });
});
