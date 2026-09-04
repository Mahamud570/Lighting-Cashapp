const https = require('https');

// In-memory cache for IP locations. Successful lookups are stable for a day;
// failures are retried quickly so a temporary API slowdown cannot make an IP
// appear unknown for the lifetime of the Node process.
const geoCache = new Map();
const SUCCESS_CACHE_MS = 24 * 60 * 60 * 1000;
const FAILURE_CACHE_MS = 60 * 1000;
const LOOKUP_TIMEOUT_MS = 8000;

function readCache(ip) {
    const entry = geoCache.get(ip);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
        geoCache.delete(ip);
        return null;
    }
    return entry.value;
}

function writeCache(ip, value, ttlMs) {
    geoCache.set(ip, { value, expiresAt: Date.now() + ttlMs });
    return value;
}

/**
 * Convert 2-letter ISO country code to Emoji Flag
 * E.g., 'US' -> '🇺🇸', 'BD' -> '🇧🇩'
 */
function getCountryFlag(countryCode) {
    if (!countryCode || countryCode.length !== 2) return '🌐';
    const code = countryCode.toUpperCase();
    const offset = 127397;
    return String.fromCodePoint(code.charCodeAt(0) + offset) + String.fromCodePoint(code.charCodeAt(1) + offset);
}

/**
 * Check if IP is loopback or private network
 */
function isPrivateIp(ip) {
    if (!ip) return true;
    const cleanIp = ip.replace(/^::ffff:/, '').trim();

    if (cleanIp === '::1' || cleanIp === '127.0.0.1' || cleanIp === 'localhost' || cleanIp === '0.0.0.0') {
        return true;
    }

    // IPv4 Private Ranges
    if (cleanIp.startsWith('10.') || cleanIp.startsWith('192.168.') || cleanIp.startsWith('127.')) {
        return true;
    }

    if (cleanIp.startsWith('172.')) {
        const parts = cleanIp.split('.');
        const second = parseInt(parts[1], 10);
        if (second >= 16 && second <= 31) return true;
    }

    // IPv6 Local/Link-local
    if (cleanIp.toLowerCase().startsWith('fe80:') || cleanIp.toLowerCase().startsWith('fc00:') || cleanIp.toLowerCase().startsWith('fd00:')) {
        return true;
    }

    return false;
}

class GeoIpService {
    /**
     * Resolve IP address to "Flag City, CountryCode" (e.g., "🇺🇸 New York, US")
     */
    static async lookup(ip) {
        if (!ip || isPrivateIp(ip)) {
            return '🏠 Localhost';
        }

        const whoerApiKey = String(process.env.WHOER_API_KEY || '').trim();
        const endpointTemplate = String(process.env.GEOIP_ENDPOINT || (whoerApiKey ? 'https://www.whoer.live/api/v2/bulk-scan' : 'https://ipwho.is/{ip}')).trim();
        if (process.env.GEOIP_ENABLED === '0') return '🌐 Location disabled';
        if (!endpointTemplate.startsWith('https://') || (!whoerApiKey && !endpointTemplate.includes('{ip}'))) return '🌐 Location unavailable';

        const cleanIp = ip.replace(/^::ffff:/, '').trim();

        // Check cache
        const cached = readCache(cleanIp);
        if (cached) return cached;

        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                const fallback = '🌐 Unknown Location';
                request.destroy();
                resolve(writeCache(cleanIp, fallback, FAILURE_CACHE_MS));
            }, LOOKUP_TIMEOUT_MS);

            const reqUrl = whoerApiKey ? endpointTemplate : endpointTemplate.replace('{ip}', encodeURIComponent(cleanIp));
            const body = whoerApiKey ? JSON.stringify({ ips: [cleanIp] }) : null;
            const requestOptions = whoerApiKey ? {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body),
                    'x-api-key': whoerApiKey
                }
            } : undefined;

            const request = https.request(reqUrl, requestOptions, (res) => {
                let data = '';
                res.on('data', chunk => {
                    if (data.length < 16384) data += chunk;
                });
                res.on('end', () => {
                    clearTimeout(timer);
                    try {
                        const parsed = JSON.parse(data);
                        const result = Array.isArray(parsed.results) ? parsed.results[0] : parsed;
                        const countryCode = result?.countryCode || result?.country_code || result?.data?.geoLocation?.countryCode;
                        const city = result?.city || result?.data?.geoLocation?.city;
                        if (result && result.error !== true && (result.status === 'success' || result.success === true || !result.status) && countryCode) {
                            const flag = getCountryFlag(countryCode);
                            const cityStr = city ? `${city}, ` : '';
                            const locationStr = `${flag} ${cityStr}${countryCode}`;
                            resolve(writeCache(cleanIp, locationStr, SUCCESS_CACHE_MS));
                        } else {
                            const fallback = '🌐 Unknown Location';
                            console.warn(`[geo] Whoer lookup returned HTTP ${res.statusCode || 0} without a location`);
                            resolve(writeCache(cleanIp, fallback, FAILURE_CACHE_MS));
                        }
                    } catch (e) {
                        const fallback = '🌐 Unknown Location';
                        console.warn(`[geo] Whoer response could not be parsed: ${e.message}`);
                        resolve(writeCache(cleanIp, fallback, FAILURE_CACHE_MS));
                    }
                });
            });
            request.on('error', (error) => {
                clearTimeout(timer);
                const fallback = '🌐 Unknown Location';
                if (error.code !== 'ECONNRESET') console.warn(`[geo] Lookup failed: ${error.message}`);
                resolve(writeCache(cleanIp, fallback, FAILURE_CACHE_MS));
            });
            if (body) request.write(body);
            request.end();
        });
    }
}

module.exports = GeoIpService;
