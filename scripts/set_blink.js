const db = require('../database/db');

async function main() {
    const apiKey = 'blink_rPgVncESLFjFLUo2NYnsL2ExkDjNYoKB9gzoi5cN1OEECdB8lxO5230PdwzFrF3f';
    const walletId = '9177eddf-466e-4a60-8113-d4c519406f0d';

    await db.query(
        'UPDATE resellers SET wallet_type = "blink", blink_api_key = ?, blink_wallet_id = ? WHERE id = 1',
        [apiKey, walletId]
    );

    console.log('✅ Blink wallet configured in database successfully!');
    process.exit(0);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
