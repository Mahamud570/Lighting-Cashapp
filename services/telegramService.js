const axios = require('axios');

/**
 * Telegram Notification Service
 */
class TelegramService {
    /**
     * Send a markdown/HTML message to a Telegram chat
     */
    static async sendMessage({ botToken, chatId, message, parseMode = 'HTML' }) {
        if (!botToken || !chatId) {
            return { sent: false, error: 'Telegram Bot Token or Chat ID is missing' };
        }

        try {
            const url = `https://api.telegram.org/bot${botToken.trim()}/sendMessage`;
            const resp = await axios.post(url, {
                chat_id: chatId.trim(),
                text: message,
                parse_mode: parseMode,
                disable_web_page_preview: true
            }, { timeout: 8000 });

            return { sent: true, data: resp.data };
        } catch (err) {
            console.error('Telegram Send Error:', err.response?.data || err.message);
            throw new Error(err.response?.data?.description || err.message);
        }
    }

    /**
     * Send instant payment received alert
     */
    static async sendPaymentAlert({ botToken, chatId, payment, settlementStatus, sweepNote }) {
        if (!botToken || !chatId) return;

        const time = new Date().toLocaleString('en-US', {
            month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true
        });

        const statusEmoji = settlementStatus === 'swept' ? '🚀' : '📦';
        const settlementText = settlementStatus === 'swept' 
            ? '<b>Auto-Swept to Binance!</b> ⚡' 
            : `<b>Held in ${payment.receiving_wallet?.toUpperCase() || 'Wallet'}</b> (Below Binance min)`;

        const msg = 
`🟢 <b>Payment Received!</b>

💰 <b>Amount:</b> $${parseFloat(payment.total_usd || payment.amount_usd).toFixed(2)} USD
⚡ <b>Satoshis:</b> ${(payment.btc_amount ? Math.round(payment.btc_amount * 100000000) : (payment.sats || 0)).toLocaleString()} sats
🔗 <b>Link:</b> <code>${payment.slug || 'Direct / Scan'}</code>
🏦 <b>Gateway:</b> <code>${payment.provider ? payment.provider.toUpperCase() : 'BLINK'}</code>
${statusEmoji} <b>Settlement:</b> ${settlementText}
${sweepNote ? `ℹ️ <i>${sweepNote}</i>\n` : ''}
⏱ <b>Time:</b> ${time}
🆔 <b>Invoice:</b> <code>${(payment.invoice_id || '').substring(0, 16)}...</code>`;

        try {
            await this.sendMessage({ botToken, chatId, message: msg });
        } catch (e) {
            console.error('Failed to dispatch Telegram payment alert:', e.message);
        }
    }

    /**
     * Send auto-sweep execution alert
     */
    static async sendSweepAlert({ botToken, chatId, sweep }) {
        if (!botToken || !chatId) return;

        const time = new Date().toLocaleString('en-US', {
            month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true
        });

        const isSuccess = sweep.status === 'completed';
        const header = isSuccess ? '🚀 <b>Binance Auto-Sweep Completed!</b>' : '⚠️ <b>Auto-Sweep Notice</b>';

        const msg = 
`${header}

💵 <b>Amount Swept:</b> $${parseFloat(sweep.amount_usd).toFixed(2)} USD
⚡ <b>Satoshis:</b> ${(sweep.amount_sats || 0).toLocaleString()} sats
🏦 <b>Destination:</b> <code>${sweep.target_destination || 'Binance Account'}</code>
📊 <b>Status:</b> ${isSuccess ? '✅ Success' : `❌ ${sweep.error_message || 'Held'}`}
${sweep.txid ? `🔗 <b>TxID:</b> <code>${sweep.txid.substring(0, 20)}...</code>\n` : ''}
⏱ <b>Time:</b> ${time}`;

        try {
            await this.sendMessage({ botToken, chatId, message: msg });
        } catch (e) {
            console.error('Failed to dispatch Telegram sweep alert:', e.message);
        }
    }
}

module.exports = TelegramService;
