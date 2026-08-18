process.env.JWT_SECRET = 'test_e2e_jwt_secret_key_12345';

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const db = require('../../database/db');

// Create test express app matching server.js
function createTestApp() {
    const app = express();
    app.use(express.json());
    app.use(cookieParser());

    app.use('/', require('../../routes/auth'));
    app.use('/', require('../../routes/dashboard'));
    app.use('/', require('../../routes/links'));
    app.use('/', require('../../routes/wallet'));
    app.use('/', require('../../routes/payments'));
    app.use('/', require('../../routes/users'));
    app.use('/', require('../../routes/security'));
    app.use('/', require('../../routes/sweeps'));
    app.use('/', require('../../routes/owner'));
    app.use('/', require('../../routes/pay'));

    return app;
}

describe('⚡ Full System End-to-End User Journeys', () => {
    let app;

    beforeAll(async () => {
        app = createTestApp();
        // Warm up database
        await db.query('SELECT 1');
    });

    // ─────────────────────────────────────────────────────────────
    // 1. MASTER / OWNER JOURNEY
    // ─────────────────────────────────────────────────────────────
    describe('👑 Master / Owner Journey', () => {
        let ownerCookie;
        let createdResellerId;
        const testResellerUser = `e2e_reseller_${Date.now()}`;

        test('Owner login succeeds with admin / admin123', async () => {
            const res = await request(app)
                .post('/api/auth/login')
                .send({ username: 'admin', password: 'admin123' });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.role).toBe('owner');
            expect(res.body.redirect).toBe('/owner');

            const cookies = res.headers['set-cookie'];
            expect(cookies).toBeDefined();
            ownerCookie = cookies.find(c => c.startsWith('auth_token='));
            expect(ownerCookie).toBeDefined();
        });

        test('Owner accesses global platform stats', async () => {
            const res = await request(app)
                .get('/api/owner/stats')
                .set('Cookie', ownerCookie);

            expect(res.status).toBe(200);
            expect(res.body).toHaveProperty('resellers');
            expect(res.body).toHaveProperty('total_payments');
            expect(res.body).toHaveProperty('total_volume_usd');
        });

        test('Owner generates a new reseller account', async () => {
            const res = await request(app)
                .post('/api/owner/resellers')
                .set('Cookie', ownerCookie)
                .send({
                    username: testResellerUser,
                    email: `${testResellerUser}@test.com`,
                    password: 'SecurePassword123!'
                });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.reseller).toHaveProperty('id');
            createdResellerId = res.body.reseller.id;
        });

        test('Owner updates reseller full configuration', async () => {
            const res = await request(app)
                .put(`/api/owner/resellers/${createdResellerId}/config`)
                .set('Cookie', ownerCookie)
                .send({
                    charge_mode: 'fixed',
                    charge_value: 0.50,
                    wallet_type: 'lnbits',
                    lnbits_url: 'https://demo.lnbits.com',
                    lnbits_invoice_key: 'test_invoice_key_123',
                    lnbits_admin_key: 'test_admin_key_123'
                });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
        });

        test('Owner resets reseller password', async () => {
            const res = await request(app)
                .post(`/api/owner/resellers/${createdResellerId}/reset-password`)
                .set('Cookie', ownerCookie)
                .send({ new_password: 'NewTempPassword123!' });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.temporary_password).toBe('NewTempPassword123!');
        });
    });

    // ─────────────────────────────────────────────────────────────
    // 2. RESELLER JOURNEY
    // ─────────────────────────────────────────────────────────────
    describe('💼 Reseller Journey', () => {
        let resellerCookie;
        let createdLinkId;
        let createdSubUserId;
        const testSlug = `e2e_slug_${Date.now()}`;
        const subUserEmail = `merchant_${Date.now()}@test.com`;

        test('Reseller login succeeds with reseller / reseller123', async () => {
            const res = await request(app)
                .post('/api/auth/login')
                .send({ username: 'reseller', password: 'reseller123' });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.role).toBe('reseller');

            const cookies = res.headers['set-cookie'];
            resellerCookie = cookies.find(c => c.startsWith('auth_token='));
            expect(resellerCookie).toBeDefined();
        });

        test('Reseller is FORBIDDEN from accessing owner routes (403)', async () => {
            const res = await request(app)
                .get('/api/owner/stats')
                .set('Cookie', resellerCookie);

            expect(res.status).toBe(403);
            expect(res.body.error).toMatch(/Forbidden/i);
        });

        test('Reseller accesses dashboard stats', async () => {
            const res = await request(app)
                .get('/api/dashboard/stats')
                .set('Cookie', resellerCookie);

            expect(res.status).toBe(200);
            expect(res.body).toHaveProperty('links');
            expect(res.body).toHaveProperty('paid_usd');
            expect(res.body).toHaveProperty('wallet_status');
        });

        test('Reseller creates payment link', async () => {
            const res = await request(app)
                .post('/api/links')
                .set('Cookie', resellerCookie)
                .send({
                    slug: testSlug,
                    title: 'E2E Test Checkout',
                    brand_name: 'Cash Pay E2E',
                    theme: 'dark',
                    amount_type: 'open',
                    min_amount: 1,
                    max_amount: 500
                });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);

            const [links] = await db.query('SELECT id FROM payment_links WHERE slug = ?', [testSlug]);
            expect(links.length).toBe(1);
            createdLinkId = links[0].id;
        });

        test('Reseller creates Sub-User (Merchant)', async () => {
            const res = await request(app)
                .post('/api/users')
                .set('Cookie', resellerCookie)
                .send({
                    name: 'Test Merchant',
                    email: subUserEmail,
                    password: 'MerchantPass123!',
                    rate_per_dollar: 1.0
                });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.temporary_password).toBe('MerchantPass123!');

            const [users] = await db.query('SELECT id FROM sub_users WHERE email = ?', [subUserEmail]);
            expect(users.length).toBe(1);
            createdSubUserId = users[0].id;
        });

        test('Reseller assigns link to Sub-User', async () => {
            const res = await request(app)
                .put(`/api/links/${createdLinkId}/assign`)
                .set('Cookie', resellerCookie)
                .send({ sub_user_id: createdSubUserId });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);

            const [link] = await db.query('SELECT sub_user_id FROM payment_links WHERE id = ?', [createdLinkId]);
            expect(link[0].sub_user_id).toBe(createdSubUserId);
        });

        test('Reseller saves Binance Auto-Sweep settings', async () => {
            const res = await request(app)
                .post('/api/sweeps/save-config')
                .set('Cookie', resellerCookie)
                .send({
                    binance_auto_sweep_enabled: true,
                    binance_sweep_threshold_usd: 10,
                    binance_sweep_type: 'lightning',
                    binance_sweep_wallet_balance_enabled: true
                });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
        });
    });

    // ─────────────────────────────────────────────────────────────
    // 3. SUB-USER (MERCHANT) JOURNEY
    // ─────────────────────────────────────────────────────────────
    describe('🏪 Sub-User (Merchant) Journey', () => {
        let subUserCookie;
        const merchantEmail = `subuser_test_${Date.now()}@test.com`;

        beforeAll(async () => {
            // Create a merchant account
            const bcrypt = require('bcryptjs');
            const hash = await bcrypt.hash('SubUserPass123!', 10);
            const [reseller] = await db.query('SELECT id FROM resellers WHERE username = "reseller"');
            const resellerId = reseller[0].id;

            await db.query(
                'INSERT INTO sub_users (reseller_id, name, email, password, status, must_change_password) VALUES (?,?,?,?,?,?)',
                [resellerId, 'Merchant John', merchantEmail, hash, 'active', 0]
            );
        });

        test('Sub-user login succeeds', async () => {
            const res = await request(app)
                .post('/api/auth/login')
                .send({ username: merchantEmail, password: 'SubUserPass123!' });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.role).toBe('sub_user');

            const cookies = res.headers['set-cookie'];
            subUserCookie = cookies.find(c => c.startsWith('auth_token='));
            expect(subUserCookie).toBeDefined();
        });

        test('Sub-user is FORBIDDEN from accessing user management (403)', async () => {
            const res = await request(app)
                .get('/api/users')
                .set('Cookie', subUserCookie);

            expect(res.status).toBe(403);
        });

        test('Sub-user is FORBIDDEN from accessing owner routes (403)', async () => {
            const res = await request(app)
                .get('/api/owner/stats')
                .set('Cookie', subUserCookie);

            expect(res.status).toBe(403);
        });
    });

    // ─────────────────────────────────────────────────────────────
    // 4. PUBLIC PAYMENT & INVOICE FLOW
    // ─────────────────────────────────────────────────────────────
    describe('⚡ Public Payment Flow (/pay/:slug)', () => {
        const publicSlug = `pay_e2e_${Date.now()}`;

        beforeAll(async () => {
            const [reseller] = await db.query('SELECT id FROM resellers WHERE username = "reseller"');
            const resellerId = reseller[0].id;

            // Configure demo LNbits on reseller
            await db.query(
                'UPDATE resellers SET wallet_type = "lnbits", lnbits_url = "https://demo.lnbits.com", lnbits_invoice_key = "4711ae726e11403bb21d8454558e75b9" WHERE id = ?',
                [resellerId]
            );

            // Create active payment link
            await db.query(
                'INSERT INTO payment_links (reseller_id, slug, title, brand_name, status) VALUES (?,?,?,?,?)',
                [resellerId, publicSlug, 'Public E2E Link', 'Cash Pay', 'active']
            );
        });

        test('Public link info returns 200 with correct metadata', async () => {
            const res = await request(app)
                .get(`/api/pay/${publicSlug}/info`);

            expect(res.status).toBe(200);
            expect(res.body.slug).toBe(publicSlug);
            expect(res.body.title).toBe('Public E2E Link');
            expect(res.body.brand_name).toBe('Cash Pay');
        });

        test('Public invoice generation returns 200 with BOLT11 and QR code', async () => {
            const res = await request(app)
                .post(`/api/pay/${publicSlug}/invoice`)
                .send({ amount: 5 });

            expect(res.status).toBe(200);
            expect(res.body).toHaveProperty('payment_id');
            expect(res.body).toHaveProperty('lightning_invoice');
            expect(res.body.lightning_invoice).toMatch(/^lnbc/);
            expect(res.body).toHaveProperty('qr_code');
            expect(res.body.amount_usd).toBe(5);
            expect(res.body.expires_in).toBe(900);
        });

        test('Demo / Test slug generates mock invoice smoothly', async () => {
            const res = await request(app)
                .post('/api/pay/test/invoice')
                .send({ amount: 10 });

            expect(res.status).toBe(200);
            expect(res.body.amount_usd).toBe(10);
            expect(res.body).toHaveProperty('lightning_invoice');
        });
    });

    // ─────────────────────────────────────────────────────────────
    // 5. LOGOUT & SESSION INVALIDATION
    // ─────────────────────────────────────────────────────────────
    describe('🔒 Logout & Session Destruction', () => {
        let testCookie;

        beforeAll(async () => {
            const res = await request(app)
                .post('/api/auth/login')
                .send({ username: 'admin', password: 'admin123' });
            const cookies = res.headers['set-cookie'];
            testCookie = cookies.find(c => c.startsWith('auth_token='));
        });

        test('Logout deletes session from database and clears cookie', async () => {
            const res = await request(app)
                .post('/api/auth/logout')
                .set('Cookie', testCookie);

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);

            // Subsequent authenticated request fails with 401
            const protectedRes = await request(app)
                .get('/api/dashboard/stats')
                .set('Cookie', testCookie);

            expect(protectedRes.status).toBe(401);
            expect(protectedRes.body.error).toBe('Session expired');
        });
    });
});
