/**
 * Unit Tests: services/geoIpService.js
 */
const GeoIpService = require('../../../services/geoIpService');

describe('GeoIpService', () => {
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
});