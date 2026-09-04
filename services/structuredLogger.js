const fs = require('fs');
const path = require('path');
const { redactText, safeErrorDetails } = require('../utils/safeError');

const LOG_DIR = path.resolve(process.env.APP_LOG_DIR || path.join(__dirname, '../logs'));
const RETENTION_DAYS = Math.min(90, Math.max(1, Number(process.env.APP_LOG_RETENTION_DAYS) || 14));
let writeQueue = Promise.resolve();

function dayStamp(date = new Date()) { return date.toISOString().slice(0, 10); }
function sanitize(value) {
    if (value instanceof Error) return safeErrorDetails(value);
    if (typeof value === 'string') return redactText(value);
    if (Array.isArray(value)) return value.map(sanitize);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /password|secret|token|api.?key/i.test(key) ? '[redacted]' : sanitize(item)]));
    return value;
}
function prune() {
    const cutoff = Date.now() - RETENTION_DAYS * 86400000;
    for (const name of fs.readdirSync(LOG_DIR)) {
        if (!/^app-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)) continue;
        const file = path.join(LOG_DIR, name);
        if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
    }
}
function write(level, event, details = {}) {
    if (process.env.NODE_ENV === 'test') return Promise.resolve();
    const record = JSON.stringify({ timestamp: new Date().toISOString(), level, event: redactText(event), ...sanitize(details) }) + '\n';
    writeQueue = writeQueue.then(async () => {
        await fs.promises.mkdir(LOG_DIR, { recursive: true, mode: 0o700 });
        await fs.promises.appendFile(path.join(LOG_DIR, `app-${dayStamp()}.jsonl`), record, { mode: 0o600 });
        if (Math.random() < 0.01) prune();
    }).catch(err => console.error('[structured-log] write failed:', redactText(err.message)));
    return writeQueue;
}

module.exports = {
    info: (event, details) => write('info', event, details),
    warn: (event, details) => write('warn', event, details),
    error: (event, err, details = {}) => write('error', event, { ...details, error: safeErrorDetails(err) }),
    flush: () => writeQueue,
    LOG_DIR
};
