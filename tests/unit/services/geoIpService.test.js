/**
 * Unit Tests: services/geoIpService.js
 */
const GeoIpService = require('../../../services/geoIpService');
const https = require('https');

describe('GeoIpService', () => {
    afterEach(() => {
        jest.restoreAllMocks();
        delete process.env.WHOER_API_KEY;
        delete process.env.GEOIP_ENDPOINT;
        delete process.env.GEOIP_ENABLED;
    });

    test('lookup: returns 🏠 Localhost for loopback and private IPs', async () => {
        expect(await GeoIpService.lookup('127.0.0.1')).toBe('🏠 Localhost');
        expect(await GeoIpService.lookup('::1')).toBe('🏠 Localhost');
        expect(await GeoIpService.lookup('192.168.1.50')).toBe('🏠 Localhost');
        expect(await GeoIpService.lookup('10.0.0.1')).toBe('🏠 Localhost');
        expect(await GeoIpService.lookup('172.16.0.1')).toBe('🏠 Localhost');
    });

    test('lookup: caches result for recurring lookups', async () => {
        const first = await GeoIpService.lookup('127.0.0.1');
        const second = await GeoIpService.lookup('127.0.0.1');
        expect(first).toBe(second);
    });

    test('lookup: securely posts to Whoer and formats its location response', async () => {
        process.env.WHOER_API_KEY = 'test-key-not-a-secret';
        process.env.GEOIP_ENDPOINT = 'https://www.whoer.live/api/v2/bulk-scan';

        let requestBody = '';
        const request = {
            on: jest.fn().mockReturnThis(),
            write: jest.fn(chunk => { requestBody += chunk; }),
            end: jest.fn()
        };

        jest.spyOn(https, 'request').mockImplementation((url, options, callback) => {
            const handlers = {};
            callback({
                on(event, handler) {
                    handlers[event] = handler;
                    if (event === 'end') {
                        handlers.data(JSON.stringify({
                            results: [{ countryCode: 'US', city: 'New York' }]
                        }));
                        handler();
                    }
                    return this;
                }
            });
            return request;
        });

        await expect(GeoIpService.lookup('8.8.4.4')).resolves.toBe('🇺🇸 New York, US');
        expect(https.request).toHaveBeenCalledWith(
            'https://www.whoer.live/api/v2/bulk-scan',
            expect.objectContaining({
                method: 'POST',
                headers: expect.objectContaining({ 'x-api-key': 'test-key-not-a-secret' })
            }),
            expect.any(Function)
        );
        expect(requestBody).toBe(JSON.stringify({ ips: ['8.8.4.4'] }));
        expect(request.end).toHaveBeenCalledTimes(1);
    });
});
