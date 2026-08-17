const http = require('http');
const https = require('https');

// In-memory cache for IP locations
const geoCache = new Map();

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

        const cleanIp = ip.replace(/^::ffff:/, '').trim();

        // Check cache
        if (geoCache.has(cleanIp)) {
            return geoCache.get(cleanIp);
        }

        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                const fallback = '🌐 Unknown Location';
                geoCache.set(cleanIp, fallback);
                resolve(fallback);
            }, 2000); // 2s max timeout

            const reqUrl = `http://ip-api.com/json/${cleanIp}?fields=status,country,countryCode,city`;
            
            http.get(reqUrl, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    clearTimeout(timer);
                    try {
                        const parsed = JSON.parse(data);
                        if (parsed.status === 'success' && parsed.countryCode) {
                            const flag = getCountryFlag(parsed.countryCode);
                            const cityStr = parsed.city ? `${parsed.city}, ` : '';
                            const locationStr = `${flag} ${cityStr}${parsed.countryCode}`;
                            geoCache.set(cleanIp, locationStr);
                            resolve(locationStr);
                        } else {
                            const fallback = '🌐 Unknown Location';
                            geoCache.set(cleanIp, fallback);
                            resolve(fallback);
                        }
                    } catch (e) {
                        const fallback = '🌐 Unknown Location';
                        geoCache.set(cleanIp, fallback);
                        resolve(fallback);
                    }
                });
            }).on('error', () => {
                clearTimeout(timer);
                const fallback = '🌐 Unknown Location';
                geoCache.set(cleanIp, fallback);
                resolve(fallback);
            });
        });
    }
}

module.exports = GeoIpService;