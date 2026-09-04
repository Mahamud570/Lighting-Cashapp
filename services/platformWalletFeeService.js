const db = require('../database/db');
const { safeErrorDetails } = require('../utils/safeError');

const SETTING_KEYS = [
    'wallet_fee_enabled',
    'wallet_fee_threshold_usd',
    'wallet_fee_amount_usd',
    'wallet_fee_lightning_address'
];

class PlatformWalletFeeService {
    static isLightningAddress(value) {
        return /^[^@\s]{1,64}@[A-Za-z0-9.-]{1,253}$/.test(String(value || '').trim());
    }

    static async settings() {
        const marks = SETTING_KEYS.map(() => '?').join(',');
        const [rows] = await db.query(`SELECT key,value FROM platform_settings WHERE key IN (${marks})`, SETTING_KEYS);
        const values = Object.fromEntries(rows.map(row => [row.key, row.value]));
        return {
            enabled: values.wallet_fee_enabled === '1',
            thresholdUsd: Math.max(0, Number(values.wallet_fee_threshold_usd) || 200),
            amountUsd: Math.max(0, Number(values.wallet_fee_amount_usd) || 0.75),
            destination: String(values.wallet_fee_lightning_address || '').trim()
        };
    }

    static async enqueue({ sourceSweepId, resellerId, sweepAmountUsd, btcPrice }) {
        const config = await this.settings();
        if (!config.enabled || !this.isLightningAddress(config.destination) || config.amountUsd <= 0 || Number(sweepAmountUsd) < config.thresholdUsd) return null;
        const amountSats = Math.max(1, Math.round((config.amountUsd / Number(btcPrice)) * 100000000));
        await db.query(
            `INSERT OR IGNORE INTO platform_wallet_fees
             (source_sweep_id,reseller_id,amount_sats,amount_usd,destination,status)
             VALUES (?,?,?,?,?,'pending')`,
            [sourceSweepId, resellerId, amountSats, config.amountUsd, config.destination]
        );
        const [rows] = await db.query('SELECT * FROM platform_wallet_fees WHERE source_sweep_id=? LIMIT 1', [sourceSweepId]);
        return rows[0] || null;
    }

    static async processRow(row, { loadReseller, resolveInvoice, payInvoice }) {
        if (!row || !['pending', 'retry'].includes(row.status)) return row?.status || 'skipped';
        const [claim] = await db.query(
            `UPDATE platform_wallet_fees SET status='processing',attempt_count=attempt_count+1,updated_at=datetime('now')
             WHERE id=? AND status IN ('pending','retry') AND (next_retry_at IS NULL OR next_retry_at<=datetime('now'))`,
            [row.id]
        );
        if (!claim || claim.affectedRows !== 1) return 'busy';

        try {
            const reseller = await loadReseller(row.reseller_id);
            if (!reseller) throw Object.assign(new Error('Reseller wallet is unavailable'), { permanent: true });
            const bolt11 = await resolveInvoice(row.destination, row.amount_sats);
            const result = await payInvoice(reseller, bolt11, '$0.75 Wallet Fee');
            await db.query(
                `UPDATE platform_wallet_fees SET status='completed',txid=?,preimage=?,network_fee_sats=?,
                 error_message=NULL,next_retry_at=NULL,updated_at=datetime('now') WHERE id=?`,
                [result.txid || null, result.preimage || null, result.fee_sats || 0, row.id]
            );
            return 'completed';
        } catch (err) {
            const details = safeErrorDetails(err);
            const uncertain = ['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET'].includes(String(details.code || '').toUpperCase()) || /timeout|socket hang up/i.test(details.message);
            const permanent = Boolean(err?.permanent) || [400, 401, 403, 404, 422].includes(details.status);
            const status = uncertain ? 'unknown' : (permanent ? 'failed_permanent' : 'retry');
            const nextRetry = status === 'retry' ? "datetime('now','+30 minutes')" : 'NULL';
            await db.query(
                `UPDATE platform_wallet_fees SET status=?,error_message=?,next_retry_at=${nextRetry},updated_at=datetime('now') WHERE id=?`,
                [status, details.message, row.id]
            );
            return status;
        }
    }

    static async enqueueAndProcess(input, handlers) {
        const row = await this.enqueue(input);
        return row ? this.processRow(row, handlers) : 'skipped';
    }

    static async due(limit = 20) {
        const [rows] = await db.query(
            `SELECT * FROM platform_wallet_fees WHERE status='retry' AND next_retry_at<=datetime('now') ORDER BY id LIMIT ?`,
            [Math.max(1, Math.min(100, Number(limit) || 20))]
        );
        return rows;
    }
}

module.exports = PlatformWalletFeeService;
