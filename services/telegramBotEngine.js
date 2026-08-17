const axios = require('axios');
const db = require('../database/db');
const BlinkService = require('./blinkService');
const BinanceService = require('./binanceService');
const PayoutService = require('./payoutService');

/**
 * Interactive Telegram Bot Engine
 * Supports 2-way commands (/start, /balance, /history, /stats, /sweep) & inline buttons
 */
class TelegramBotEngine {
    constructor() {
        this.running = false;
        this.lastUpdateId = 0;
        this.pollTimeout = null;
    }

    start() {
        if (this.running) return;
        this.running = true;
        this.pollUpdates();
        console.log('🤖 Telegram Interactive Bot Engine started');
    }

    stop() {
        this.running = false;
        if (this.pollTimeout) clearTimeout(this.pollTimeout);
    }

    async pollUpdates() {
        if (!this.running) return;

        try {
            const [resellers] = await db.query('SELECT * FROM resellers WHERE telegram_bot_token IS NOT NULL LIMIT 1');
            if (!resellers.length || !resellers[0].telegram_bot_token) {
                this.pollTimeout = setTimeout(() => this.pollUpdates(), 5000);
                return;
            }

            const reseller = resellers[0];
            const token = reseller.telegram_bot_token.trim();

            const url = `https://api.telegram.org/bot${token}/getUpdates?offset=${this.lastUpdateId + 1}&timeout=15`;
            const resp = await axios.get(url, { timeout: 20000 });

            if (resp.data.ok && Array.isArray(resp.data.result)) {
                for (const update of resp.data.result) {
                    this.lastUpdateId = update.update_id;
                    await this.handleUpdate(token, reseller, update);
                }
            }
        } catch (err) {
            // Backoff on network error
        }

        if (this.running) {
            this.pollTimeout = setTimeout(() => this.pollUpdates(), 1500);
        }
    }

    async handleUpdate(token, reseller, update) {
        try {
            // Handle Messages
            if (update.message && update.message.text) {
                const chatId = update.message.chat.id;
                const text = update.message.text.trim().toLowerCase();

                if (text.startsWith('/start') || text.startsWith('/help') || text === 'menu') {
                    await this.sendMainMenu(token, chatId, update.message.from?.first_name || 'there');
                } else if (text.startsWith('/balance') || text.includes('balance')) {
                    await this.sendBalanceInfo(token, chatId, reseller);
                } else if (text.startsWith('/history') || text.includes('history')) {
                    await this.sendPaymentHistory(token, chatId, reseller);
                } else if (text.startsWith('/stats') || text.includes('stats')) {
                    await this.sendStats(token, chatId, reseller);
                } else if (text.startsWith('/sweep') || text.includes('sweep')) {
                    await this.sendSweepsInfo(token, chatId, reseller);
                } else {
                    await this.sendMainMenu(token, chatId, update.message.from?.first_name || 'there');
                }
            }

            // Handle Inline Button Clicks
            if (update.callback_query) {
                const query = update.callback_query;
                const chatId = query.message.chat.id;
                const data = query.data;

                // Acknowledge callback
                await axios.post(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
                    callback_query_id: query.id
                }).catch(() => {});

                if (data === 'btn_balance') {
                    await this.sendBalanceInfo(token, chatId, reseller);
                } else if (data === 'btn_history') {
                    await this.sendPaymentHistory(token, chatId, reseller);
                } else if (data === 'btn_stats') {
                    await this.sendStats(token, chatId, reseller);
                } else if (data === 'btn_sweeps') {
                    await this.sendSweepsInfo(token, chatId, reseller);
                } else if (data === 'btn_menu') {
                    await this.sendMainMenu(token, chatId, query.from?.first_name || 'there');
                }
            }
        } catch (e) {
            console.error('Error handling Telegram update:', e.message);
        }
    }

    async sendMainMenu(token, chatId, name) {
        const msg = 
`🟢 <b>Cash App Lightning Pay Assistant</b>

👋 Hello, <b>${name}</b>!
Choose an action below to view your sales stats, check live Blink/Binance balances, or see recent payment history:`;

        const keyboard = {
            inline_keyboard: [
                [
                    { text: '💰 Live Balance', callback_data: 'btn_balance' },
                    { text: '📊 Sales Stats', callback_data: 'btn_stats' }
                ],
                [
                    { text: '📜 Payment History', callback_data: 'btn_history' },
                    { text: '🔄 Auto-Sweeps', callback_data: 'btn_sweeps' }
                ]
            ]
        };

        await this.sendRaw(token, chatId, msg, keyboard);
    }

    async sendBalanceInfo(token, chatId, reseller) {
        let blinkText = 'Not connected';
        let binanceText = 'Not connected';

        // 1. Panel Revenue & Balance from DB
        const [paidRows] = await db.query(
            'SELECT COALESCE(SUM(total_usd),0) as total, COUNT(*) as count FROM payments WHERE reseller_id = ? AND status="paid"',
            [reseller.id]
        );
        const [todayRows] = await db.query(
            "SELECT COALESCE(SUM(total_usd),0) as total FROM payments WHERE reseller_id = ? AND status='paid' AND paid_at >= datetime('now', '-1 day')",
            [reseller.id]
        );
        const panelTotal = parseFloat(paidRows[0]?.total || 0).toFixed(2);
        const panelToday = parseFloat(todayRows[0]?.total || 0).toFixed(2);
        const paidCount = paidRows[0]?.count || 0;

        // 2. Blink Balance
        if (reseller.blink_api_key) {
            try {
                const bDetails = await BlinkService.getWalletDetails({ apiKey: reseller.blink_api_key });
                const sats = bDetails.balance_sats || 0;
                const usdEst = (sats * 0.00063).toFixed(2);
                blinkText = `<b>${sats.toLocaleString()} sats</b> (~$${usdEst} USD)`;
            } catch (e) {
                blinkText = 'Error fetching';
            }
        }

        // 3. Binance Balance
        if (reseller.binance_api_key && reseller.binance_api_secret) {
            try {
                const bBal = await BinanceService.testConnection({
                    apiKey: reseller.binance_api_key,
                    apiSecret: reseller.binance_api_secret
                });
                binanceText = `<b>${bBal.btc_free} BTC</b> | <b>${parseFloat(bBal.usdt_free).toFixed(2)} USDT</b>`;
            } catch (e) {
                binanceText = 'Connected';
            }
        }

        let sweepInfoText = '';
        if (reseller.binance_auto_sweep_enabled) {
            const btcPrice = await PayoutService.getBtcPrice();
            const thresholdUsd = reseller.binance_sweep_threshold_usd || 0;
            const thresholdSats = Math.max(10000, Math.round((thresholdUsd / btcPrice) * 100000000));
            
            if (reseller.binance_sweep_wallet_balance_enabled) {
                sweepInfoText = `<i>💡 Accumulated wallet balance auto-sweeps to Binance when it reaches ≥ ${thresholdSats.toLocaleString()} sats ($${thresholdUsd.toFixed(2)}).</i>`;
            } else {
                sweepInfoText = `<i>💡 Payments auto-sweep to Binance immediately if ≥ 10,000 sats ($7+). Smaller payments are held.</i>`;
            }
        } else {
            sweepInfoText = `<i>💡 Auto-sweeps to Binance are currently disabled.</i>`;
        }

        const msg = 
`💰 <b>Complete Balances & Overview</b>

🖥 <b>Panel Total Revenue:</b> <b>$${panelTotal} USD</b> (${paidCount} paid orders)
📅 <b>Today's Volume:</b> <b>$${panelToday} USD</b>

⚡ <b>Blink Gateway:</b> ${blinkText}
🏦 <b>Binance Spot:</b> ${binanceText}

${sweepInfoText}`;

        const keyboard = {
            inline_keyboard: [
                [{ text: '📜 View Payments', callback_data: 'btn_history' }, { text: '🔄 Auto-Sweeps', callback_data: 'btn_sweeps' }],
                [{ text: '« Back to Menu', callback_data: 'btn_menu' }]
            ]
        };

        await this.sendRaw(token, chatId, msg, keyboard);
    }

    async sendPaymentHistory(token, chatId, reseller) {
        const [payments] = await db.query(
            `SELECT * FROM payments WHERE reseller_id = ? ORDER BY id DESC LIMIT 5`,
            [reseller.id]
        );

        if (!payments.length) {
            return await this.sendRaw(token, chatId, '📜 <b>Payment History:</b>\n\nNo payments recorded yet.', {
                inline_keyboard: [[{ text: '« Back to Menu', callback_data: 'btn_menu' }]]
            });
        }

        let list = '';
        payments.forEach((p, idx) => {
            const time = new Date(p.created_at || Date.now()).toLocaleDateString('en-US', {
                month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
            });
            const statusEmoji = p.status === 'paid' ? '✅' : (p.status === 'pending' ? '⏳' : '⌛');
            list += `${idx + 1}. ${statusEmoji} <b>$${parseFloat(p.total_usd).toFixed(2)} USD</b> (${(p.btc_amount ? Math.round(p.btc_amount * 100000000) : 0).toLocaleString()} sats)\n   📅 <i>${time}</i> • Status: <b>${(p.status || 'unknown').toUpperCase()}</b>\n\n`;
        });

        const msg = 
`📜 <b>Recent Payments (Last 5)</b>

${list.trim()}`;

        const keyboard = {
            inline_keyboard: [
                [{ text: '🔄 View Sweeps', callback_data: 'btn_sweeps' }, { text: '« Back to Menu', callback_data: 'btn_menu' }]
            ]
        };

        await this.sendRaw(token, chatId, msg, keyboard);
    }

    async sendStats(token, chatId, reseller) {
        const [paidRows] = await db.query('SELECT COALESCE(SUM(total_usd),0) as total FROM payments WHERE reseller_id = ? AND status="paid"', [reseller.id]);
        const [totalInvRows] = await db.query('SELECT COUNT(*) as count FROM payments WHERE reseller_id = ?', [reseller.id]);
        const [paid7dRows] = await db.query("SELECT COALESCE(SUM(total_usd),0) as total FROM payments WHERE reseller_id = ? AND status='paid' AND paid_at >= datetime('now', '-7 days')", [reseller.id]);

        const totalPaid = paidRows[0]?.total || 0;
        const totalCount = totalInvRows[0]?.count || 0;
        const paid7d = paid7dRows[0]?.total || 0;

        const msg = 
`📊 <b>Sales & Revenue Overview</b>

🟢 <b>Total Paid Volume:</b> $${parseFloat(totalPaid).toFixed(2)} USD
📈 <b>Last 7 Days:</b> $${parseFloat(paid7d).toFixed(2)} USD
🧾 <b>Total Invoices:</b> ${totalCount}
⚡ <b>Active Gateway:</b> <code>${(reseller.wallet_type || 'Blink').toUpperCase()}</code>
🏦 <b>Binance Auto-Sweep:</b> <code>${reseller.binance_auto_sweep_enabled ? 'ENABLED (Threshold: $' + (reseller.binance_sweep_threshold_usd || 0) + ')' : 'DISABLED'}</code>
🔄 <b>Wallet Sweep:</b> <code>${reseller.binance_sweep_wallet_balance_enabled ? 'ENABLED' : 'DISABLED'}</code>`;

        const keyboard = {
            inline_keyboard: [
                [{ text: '💰 Check Balance', callback_data: 'btn_balance' }, { text: '« Back to Menu', callback_data: 'btn_menu' }]
            ]
        };

        await this.sendRaw(token, chatId, msg, keyboard);
    }

    async sendSweepsInfo(token, chatId, reseller) {
        const [sweeps] = await db.query(
            `SELECT * FROM auto_sweeps WHERE reseller_id = ? ORDER BY id DESC LIMIT 5`,
            [reseller.id]
        );

        if (!sweeps.length) {
            return await this.sendRaw(token, chatId, '🔄 <b>Auto-Sweep History:</b>\n\nNo sweeps executed yet.', {
                inline_keyboard: [[{ text: '« Back to Menu', callback_data: 'btn_menu' }]]
            });
        }

        let list = '';
        sweeps.forEach((s, idx) => {
            const time = new Date(s.created_at || Date.now()).toLocaleDateString('en-US', {
                month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
            });
            const icon = s.status === 'completed' ? '🚀' : (s.status === 'held' ? '📦' : '⚠️');
            list += `${idx + 1}. ${icon} <b>$${parseFloat(s.amount_usd).toFixed(2)} USD</b> (${(s.amount_sats || 0).toLocaleString()} sats)\n   Status: <b>${s.status.toUpperCase()}</b>\n   ℹ️ <i>${s.error_message || (s.status === 'completed' ? 'Swept to Binance' : 'Pending')}</i>\n\n`;
        });

        const msg = 
`🔄 <b>Auto-Sweep & Settlement Log</b>

${list.trim()}`;

        const keyboard = {
            inline_keyboard: [
                [{ text: '💰 Check Balance', callback_data: 'btn_balance' }, { text: '« Back to Menu', callback_data: 'btn_menu' }]
            ]
        };

        await this.sendRaw(token, chatId, msg, keyboard);
    }

    async sendRaw(token, chatId, text, replyMarkup = null) {
        const payload = {
            chat_id: chatId,
            text,
            parse_mode: 'HTML',
            disable_web_page_preview: true
        };
        if (replyMarkup) payload.reply_markup = replyMarkup;

        return await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, payload);
    }
}

module.exports = new TelegramBotEngine();
