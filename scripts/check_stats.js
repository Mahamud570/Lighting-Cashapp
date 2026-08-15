const db = require('../database/db');

async function main() {
    // Delete corrupt test records
    await db.query("DELETE FROM payments WHERE status IS NULL OR created_at LIKE 'http%'");

    const [payments] = await db.query("SELECT id, invoice_id, provider, amount_usd, total_usd, status, paid_at, created_at FROM payments ORDER BY id DESC LIMIT 10");
    console.log('Cleaned Payments in DB:', payments);

    const [paidRows] = await db.query("SELECT COALESCE(SUM(total_usd),0) as total FROM payments WHERE status = 'paid'");
    console.log('Total Paid:', paidRows[0]);
}

main().catch(console.error);
