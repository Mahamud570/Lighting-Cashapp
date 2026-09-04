const db = require('../database/db');
const { safeErrorDetails } = require('../utils/safeError');

class SettlementJobService {
    static async claim({ paymentId, resellerId, operationKey, amountSats }) {
        await db.query(
            `INSERT OR IGNORE INTO settlement_jobs
             (payment_id, reseller_id, operation_key, status, amount_sats)
             VALUES (?, ?, ?, 'pending', ?)`,
            [paymentId, resellerId, operationKey, Math.max(0, Math.trunc(Number(amountSats) || 0))]
        );
        const [result] = await db.query(
            `UPDATE settlement_jobs
             SET status = 'processing', attempt_count = attempt_count + 1,
                 amount_sats = ?, last_error = NULL, updated_at = datetime('now')
             WHERE payment_id = ? AND operation_key = ?
               AND status IN ('pending','retry')
               AND (next_retry_at IS NULL OR next_retry_at <= datetime('now'))`,
            [Math.max(0, Math.trunc(Number(amountSats) || 0)), paymentId, operationKey]
        );
        return Boolean(result && result.affectedRows === 1);
    }

    static async complete(paymentId, operationKey, externalReference) {
        await db.query(
            `UPDATE settlement_jobs SET status = 'completed', external_reference = ?,
             next_retry_at = NULL, last_error = NULL, updated_at = datetime('now')
             WHERE payment_id = ? AND operation_key = ? AND status = 'processing'`,
            [externalReference || null, paymentId, operationKey]
        );
    }

    static async hold(paymentId, operationKey, reason) {
        await db.query(
            `UPDATE settlement_jobs SET status = 'held', last_error = ?,
             next_retry_at = NULL, updated_at = datetime('now')
             WHERE payment_id = ? AND operation_key = ? AND status = 'processing'`,
            [String(reason || 'Held'), paymentId, operationKey]
        );
    }

    static async fail(paymentId, operationKey, err) {
        const details = safeErrorDetails(err);
        const timeout = /timeout|timed out|ECONNRESET|socket hang up/i.test(`${details.code || ''} ${details.message || ''}`);
        const permanent = err?.permanent === true || details.status === 401 || details.status === 403 || /invalid.*(?:key|credential|invoice)|unauthori[sz]ed|forbidden/i.test(details.message || '');
        const status = (timeout || err?.externalOutcomeUnknown) ? 'unknown' : (permanent ? 'failed_permanent' : 'retry');
        const nextRetry = status === 'retry' ? "datetime('now', '+15 minutes')" : 'NULL';
        await db.query(
            `UPDATE settlement_jobs SET status = ?, last_error = ?, next_retry_at = ${nextRetry},
             updated_at = datetime('now') WHERE payment_id = ? AND operation_key = ? AND status = 'processing'`,
            [status, details.message || 'Settlement failed', paymentId, operationKey]
        );
        return status;
    }

    static async isCompleted(paymentId, operationKey) {
        const [rows] = await db.query(
            "SELECT id FROM settlement_jobs WHERE payment_id = ? AND operation_key = ? AND status = 'completed' LIMIT 1",
            [paymentId, operationKey]
        );
        return rows.length > 0;
    }

    static async duePaymentIds(limit = 25) {
        const safeLimit = Math.min(100, Math.max(1, Math.trunc(Number(limit) || 25)));
        const [rows] = await db.query(
            `SELECT DISTINCT payment_id FROM settlement_jobs
             WHERE status = 'retry' AND (next_retry_at IS NULL OR next_retry_at <= datetime('now'))
             ORDER BY updated_at ASC LIMIT ${safeLimit}`
        );
        return rows.map(row => Number(row.payment_id)).filter(Number.isInteger);
    }

    static async quarantineStaleProcessing() {
        const [result] = await db.query(
            `UPDATE settlement_jobs SET status = 'unknown',
             last_error = 'Process stopped while external outcome was unresolved',
             next_retry_at = NULL, updated_at = datetime('now')
             WHERE status = 'processing' AND updated_at < datetime('now', '-5 minutes')`
        );
        return Number(result?.affectedRows || 0);
    }
}

module.exports = SettlementJobService;
