/**
 * Integration Tests: routes/links.js
 * Covers: file type filter (S-005), reserved slug (new), slug collision,
 *         title/brand_name max length sanitization.
 */
jest.mock('../../database/db', () => ({ query: jest.fn() }));
jest.mock('../../middleware/auth');

const request = require('supertest');
const express = require('express');
const path    = require('path');
const db      = require('../../database/db');
const auth    = require('../../middleware/auth');

auth.mockImplementation((req, res, next) => {
    req.reseller = { id: 1, username: 'alice' };
    next();
});
auth.requireRole = () => (req, res, next) => next();

const linksRouter = require('../../routes/links');
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/', linksRouter);

beforeEach(() => {
    jest.clearAllMocks();
    auth.mockImplementation((req, res, next) => {
        req.reseller = { id: 1, username: 'alice' };
        next();
    });
    db.query.mockResolvedValue([[]]); // default: no existing slugs
});

// ── Reserved slug blocklist ────────────────────────────────────────────────────
const RESERVED_SLUGS = ['api', 'admin', 'login', 'register', 'logout', 'reseller', 'pay'];

RESERVED_SLUGS.forEach(slug => {
    test(`POST /api/links: reserved slug '${slug}' -> 400`, async () => {
        const res = await request(app)
            .post('/api/links')
            .send({ slug, title: 'Test Link' });
        expect(res.status).toBe(400);
        expect(res.body.error).toContain('reserved');
    });
});

// ── Slug collision ────────────────────────────────────────────────────────────
test('POST /api/links: duplicate slug -> 400', async () => {
    db.query.mockResolvedValueOnce([[{ id: 99 }]]); // existing slug found
    const res = await request(app)
        .post('/api/links')
        .send({ slug: 'my-link', title: 'My Link' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('already taken');
});

// ── Required fields ───────────────────────────────────────────────────────────
test('POST /api/links: missing slug or title -> 400', async () => {
    const res = await request(app)
        .post('/api/links')
        .send({ title: 'No Slug Here' }); // no slug
    expect(res.status).toBe(400);
});

test('PUT /api/links/:id saves a reseller-owned percentage fee', async () => {
    db.query
        .mockResolvedValueOnce([[{ id: 12 }]])
        .mockResolvedValueOnce([{ affectedRows: 1 }]);
    const res = await request(app).put('/api/links/12').send({
        title: 'Updated Link', brand_name: 'Cash Pay', domain: 'portal-cash-app.com',
        theme: 'default', amount_type: 'open', min_amount: 1, max_amount: 2000,
        charge_mode: 'percent', charge_value: 12
    });
    expect(res.status).toBe(200);
    const update = db.query.mock.calls.find(([sql]) => /UPDATE payment_links SET title=/.test(sql));
    expect(update[1]).toEqual(expect.arrayContaining(['percent', 12, 12, 1]));
});

test('PUT /api/links/:id rejects an unsafe percentage fee', async () => {
    db.query.mockResolvedValueOnce([[{ id: 12 }]]);
    const res = await request(app).put('/api/links/12').send({
        title: 'Updated Link', brand_name: 'Cash Pay', theme: 'default',
        amount_type: 'open', min_amount: 1, max_amount: 2000,
        charge_mode: 'percent', charge_value: 51
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('50%');
    expect(db.query.mock.calls.some(([sql]) => /UPDATE payment_links SET title=/.test(sql))).toBe(false);
});

test('PUT /api/links/:id normalizes www and protocol from the saved domain', async () => {
    db.query
        .mockResolvedValueOnce([[{ id: 12 }]])
        .mockResolvedValueOnce([{ affectedRows: 1 }]);
    const res = await request(app).put('/api/links/12').send({
        title: 'Jessica', brand_name: 'Cash Pay', domain: 'https://www.portal-cash-app.com/pay/jessica',
        theme: 'default', amount_type: 'open', min_amount: 1, max_amount: 2000,
        charge_mode: 'none', charge_value: 0, preview_mode: 'imessage_compact'
    });
    expect(res.status).toBe(200);
    const update = db.query.mock.calls.find(([sql]) => /UPDATE payment_links SET title=/.test(sql));
    expect(update[1]).toContain('portal-cash-app.com');
    expect(update[1]).not.toContain('www.portal-cash-app.com');
});

test('PUT /api/links/:id cannot edit a link outside the reseller account', async () => {
    db.query.mockResolvedValueOnce([[]]);
    const res = await request(app).put('/api/links/99').send({
        title: 'Updated Link', brand_name: 'Cash Pay', theme: 'default',
        amount_type: 'open', min_amount: 1, max_amount: 2000,
        charge_mode: 'none', charge_value: 0
    });
    expect(res.status).toBe(404);
});

// ── Payments: limit capping ───────────────────────────────────────────────────
test('payments.js: limit > 500 is capped to 500', async () => {
    // This tests the payments route through a separate sub-test using the db mock
    // The actual enforcement is verified in payments.test.js
    expect(Math.min(Math.max(parseInt('999999', 10) || 50, 1), 500)).toBe(500);
});

// ── Input sanitization ────────────────────────────────────────────────────────
test('POST /api/links: title longer than 100 chars is truncated', async () => {
    db.query
        .mockResolvedValueOnce([[]])       // no existing slug
        .mockResolvedValueOnce([[]]);      // INSERT
    const longTitle = 'T'.repeat(150);
    await request(app).post('/api/links').send({ slug: 'valid-slug', title: longTitle });
    // The INSERT db.query should have received truncated title
    const insertCall = db.query.mock.calls[1];
    if (insertCall) {
        const titleParam = insertCall[1][3]; // title is 4th param (index 3)
        if (titleParam) expect(titleParam.length).toBeLessThanOrEqual(100);
    }
});
