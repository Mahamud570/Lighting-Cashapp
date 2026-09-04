const fs = require('fs');
const path = require('path');

describe('MariaDB compatibility schema', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../../database/mysql.js'), 'utf8');

    test.each(['label', 'last_used', 'revoked_at'])(
        'trusted_devices includes the %s column required by authentication and security routes',
        column => expect(source).toMatch(new RegExp(`trusted_devices:\\{[^}]*${column}:`))
    );

    test('legacy SQLite migration filters obsolete columns against the destination schema', () => {
        expect(source).toContain("SHOW COLUMNS FROM \\`${table}\\`");
        expect(source).toContain('filter(x=>allowed.has(x.name))');
    });
});
