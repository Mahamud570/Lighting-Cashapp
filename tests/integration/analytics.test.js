/**
 * Integration Tests: routes/analytics.js
 *
 * Regression tests for BUG-001 (req.user -> req.reseller crash) and BUG-002
 * (SQL string interpolation). These tests verify the routes return 200 with
 * auth middleware properly wiring req.reseller.
 */
jest.mock('../../database/db');
jest.mock('../../middleware/auth');

const request = require('supertest');
const express = require('express');
const db      = require('../../database/db');
const auth    = require('../../middleware/auth');

// Mock auth middleware to inject req.reseller
auth.mockImplementation((req, res, next) => {
    req.reseller = { id: 42, username: 'test_reseller' };
    next();
});
auth.requireRole = () => (req, res, next) => next();

const analyticsRouter = require('../../routes/analytics');
const app = express();
app.use(express.json());
app.use('/', analyticsRouter);

beforeEach(() => {
    jest.clearAllMocks();
    auth.mockImplementation((req, res, next) => {
        req.reseller = { id: 42, username: 'test_reseller' };
        next();
    });
});

// ── Overview ──────────────────────────────────────────────────────────────────
test('GET /api/analytics/overview: 200 with correct shape', async () => {
    const mockRow = [{ total_revenue: '123.45', total_paid: 10, total_invoices: 15, avg_order: '12.35' }];
    const mockPeriod = [{ revenue: '50.00', count: 5 }];
    const mockSweeps = [{ swept: 3, held: 1, failed: 0, swept_usd: '45.00' }];

    db.query
        .mockResolvedValueOnce([mockRow])   // totals
        .mockResolvedValueOnce([mockPeriod]) // today
        .mockResolvedValueOnce([mockPeriod]) // week
        .mockResolvedValueOnce([mockPeriod]) // month
        .mockResolvedValueOnce([mockPeriod]) // prevWeek
        .mockResolvedValueOnce([mockSweeps]); // sweepTotals

    const res = await request(app).get('/api/analytics/overview');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('total_revenue');
    expect(res.body).toHaveProperty('sweeps');
    expect(res.body.sweeps).toHaveProperty('swept', 3);
});

test('GET /api/analytics/overview: DB error -> 500', async () => {
    db.query.mockRejectedValueOnce(new Error('DB crash'));
    const res = await request(app).get('/api/analytics/overview');
    expect(res.status).toBe(500);
    expect(res.body).toHaveProperty('error');
    // Must NOT expose raw error: 'DB crash'
    expect(res.body.error).not.toContain('DB crash');
});

// ── Chart ─────────────────────────────────────────────────────────────────────
test('GET /api/analytics/chart: 200 with labels array', async () => {
    db.query.mockResolvedValueOnce([[
        { day: '2024-01-01', revenue: '10.00', count: 2 }
    ]]);
    const res = await request(app).get('/api/analytics/chart?period=7');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('labels');
    expect(res.body).toHaveProperty('revenues');
    expect(Array.isArray(res.body.labels)).toBe(true);
    expect(res.body.labels.length).toBe(7);
});

test('GET /api/analytics/chart: period clamped to 7 minimum', async () => {
    db.query.mockResolvedValueOnce([[]]);
    const res = await request(app).get('/api/analytics/chart?period=1');
    expect(res.status).toBe(200);
    expect(res.body.labels.length).toBe(7); // clamped to 7
});

test('GET /api/analytics/chart: period clamped to 90 maximum', async () => {
    db.query.mockResolvedValueOnce([[]]);
    const res = await request(app).get('/api/analytics/chart?period=999');
    expect(res.status).toBe(200);
    expect(res.body.labels.length).toBe(90); // clamped to 90
});

test('BUG-002 regression: SQL param binding used (db.query second arg contains interval string)', async () => {
    db.query.mockResolvedValueOnce([[]]);
    await request(app).get('/api/analytics/chart?period=30');
    const [sql, params] = db.query.mock.calls[0];
    // The days param ('-30 days') should be in params, NOT interpolated into the SQL string
    expect(sql).not.toContain('-30 days');
    expect(params).toContain('-30 days');
});

// ── Top Links ─────────────────────────────────────────────────────────────────
test('GET /api/analytics/top-links: 200 with array', async () => {
    db.query.mockResolvedValueOnce([[
        { title: 'Test Link', slug: 'test', payment_count: 5, total_revenue: '100.00', last_payment: null }
    ]]);
    const res = await request(app).get('/api/analytics/top-links');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0].slug).toBe('test');
});

// ── Recent ────────────────────────────────────────────────────────────────────
test('GET /api/analytics/recent: 200 with payment array', async () => {
    db.query.mockResolvedValueOnce([[
        { id: 1, total_usd: 25.00, status: 'paid', paid_at: '2024-01-01', created_at: '2024-01-01', payer_ip: '1.2.3.4', link_title: 'Test', slug: 'test' }
    ]]);
    const res = await request(app).get('/api/analytics/recent');
    expect(res.status).toBe(200);
    expect(res.body[0].status).toBe('paid');
});
