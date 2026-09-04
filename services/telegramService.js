const axios = require('axios');
const escapeHtml = value => String(value ?? '').replace(/[&<>]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[char]));

/**
 * Telegram Notification Service
 */
class TelegramService {
    static async validateBot(botToken) {
        const token = String(botToken || '').trim();
        if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) throw Object.assign(new Error('Invalid Telegram bot token format'), { permanent: true });
        try {
            const resp = await axios.get(`https://api.telegram.org/bot${token}/getMe`, { timeout: 8000 });
            if (!resp.data?.ok) throw new Error('Telegram rejected the bot token');
            return resp.data.result;
        } catch (err) {
            const description = err.response?.data?.description || err.message;
            throw Object.assign(new Error(`Telegram bot validation failed: ${description}`), { permanent: true });
        }
    }

    static async validateChat({ botToken, chatId }) {
        const token = String(botToken || '').trim();
        const chat = String(chatId || '').trim();
        if (!chat) throw Object.assign(new Error('Telegram Chat ID is required'), { permanent: true });
        try {
            const resp = await axios.get(`https://api.telegram.org/bot${token}/getChat`, { params: { chat_id: chat }, timeout: 8000 });
            if (!resp.data?.ok) throw new Error('Telegram could not access this chat');
            return resp.data.result;
        } catch (err) {
            const description = err.response?.data?.description || err.message;
            throw Object.assign(new Error(`Telegram chat validation failed: ${description}. Open the bot and send /start first.`), { permanent: true });
        }
    }

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
                chat_id: String(chatId).trim(),
                text: message,
                parse_mode: parseMode,
                disable_web_page_preview: true
            }, { timeout: 8000 });

            return { sent: true, data: resp.data };
        } catch (err) {
            const status = Number.isInteger(err.response?.status) ? err.response.status : undefined;
            const providerDescription = String(err.response?.data?.description || '').trim();
            console.error('Telegram Send Error:', status || err.code || 'request failed');
            const notificationError = new Error(providerDescription
                ? `Telegram rejected notification: ${providerDescription}`
                : 'Telegram notification could not be delivered');
            notificationError.status = status;
            notificationError.code = err.code;
            notificationError.permanent = [400, 401, 403, 404].includes(status);
            throw notificationError;
        }
    }

    static async editMessage({ botToken, chatId, messageId, message, parseMode = 'HTML' }) {
        const url = `https://api.telegram.org/bot${String(botToken || '').trim()}/editMessageText`;
        const resp = await axios.post(url, {
            chat_id: String(chatId), message_id: Number(messageId), text: message,
            parse_mode: parseMode, disable_web_page_preview: true
        }, { timeout: 8000 });
        return { edited: true, data: resp.data };
    }

    /**
     * Send instant payment received alert
     */
    static async sendPaymentAlert({ botToken, chatId, payment, settlementStatus, sweepNote }) {
        if (!botToken || !chatId) return { sent: false, error: 'Telegram Bot Token or Chat ID is missing' };

        const time = new Date().toLocaleString('en-US', {
            month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true
        });

        const statusEmoji = settlementStatus === 'swept' ? '🚀' : (settlementStatus === 'processing' ? '⏳' : '📦');
        const settlementText = settlementStatus === 'swept'
            ? '<b>Auto-Swept to Binance!</b> ⚡'
            : settlementStatus === 'processing'
                ? '<b>Payment confirmed; settlement processing</b>'
                : `<b>Held in ${escapeHtml(payment.receiving_wallet?.toUpperCase() || 'Wallet')}</b> (Below Binance min)`;

        const linkLabel = payment.link_title
            ? `${escapeHtml(payment.link_title)} — /${escapeHtml(payment.slug || 'direct')}`
            : `/${escapeHtml(payment.slug || 'direct')}`;
        const msg = 
`🟢 <b>Payment Received!</b>

💰 <b>Amount:</b> $${parseFloat(payment.total_usd || payment.amount_usd).toFixed(2)} USD
⚡ <b>Satoshis:</b> ${(Number(payment.amount_sats) || Number(payment.sats) || (payment.btc_amount ? Math.round(payment.btc_amount * 100000000) : 0)).toLocaleString()} sats
🔗 <b>Payment Link:</b> ${linkLabel}
🏦 <b>Gateway:</b> <code>${escapeHtml(payment.provider ? payment.provider.toUpperCase() : 'BLINK')}</code>
${statusEmoji} <b>Settlement:</b> ${settlementText}
${sweepNote ? `ℹ️ <i>${escapeHtml(sweepNote)}</i>\n` : ''}
⏱ <b>Time:</b> ${time}
🆔 <b>Invoice:</b> <code>${escapeHtml(payment.invoice_id || 'Unavailable')}</code>`;

        return this.sendMessage({ botToken, chatId, message: msg });
    }

    static buildSettlementUpdate({ payment, sweep, walletFeeStatus = null }) {
        const linkLabel = payment.link_title
            ? `${escapeHtml(payment.link_title)} — /${escapeHtml(payment.slug || 'direct')}`
            : `/${escapeHtml(payment.slug || 'direct')}`;
        return `✅ <b>Settlement Completed!</b>

🔗 <b>Payment Link:</b> ${linkLabel}
💰 <b>Total Paid:</b> $${Number(payment.total_usd || payment.amount_usd || 0).toFixed(2)} USD
⚡ <b>Satoshis:</b> ${Number(sweep.amount_sats || payment.amount_sats || 0).toLocaleString()} sats
🚀 <b>Binance Sweep:</b> Completed
${walletFeeStatus ? `💳 <b>$0.75 Wallet Fee:</b> ${escapeHtml(walletFeeStatus)}\n` : ''}🆔 <b>Invoice:</b> <code>${escapeHtml(payment.invoice_id || 'Unavailable')}</code>
🔗 <b>Full TXID / Payment Hash:</b>
<code>${escapeHtml(sweep.txid || 'Unavailable')}</code>`;
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
🏦 <b>Destination:</b> <code>${escapeHtml(sweep.target_destination || 'Binance Account')}</code>
📊 <b>Status:</b> ${isSuccess ? '✅ Success' : `❌ ${escapeHtml(sweep.error_message || 'Held')}`}
${sweep.txid ? `🔗 <b>Full TXID / Payment Hash:</b>\n<code>${escapeHtml(sweep.txid)}</code>\n` : ''}
⏱ <b>Time:</b> ${time}`;

        try {
            await this.sendMessage({ botToken, chatId, message: msg });
        } catch (e) {
            console.error('Failed to dispatch Telegram sweep alert:', e.message);
        }
    }
}

module.exports = TelegramService;
