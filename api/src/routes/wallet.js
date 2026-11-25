const express = require('express');
const pool = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { pricing, estimate, credit, FREE_CANCEL_MIN, PENALTY_PCT } = require('../payments');

const router = express.Router();

// GET /wallet - balance and recent transactions
router.get('/', authenticate, async (req, res) => {
  try {
    const bal = await pool.query('SELECT wallet_balance FROM users WHERE id = $1', [req.user.id]);
    const tx = await pool.query(
      `SELECT id, booking_id, amount, type, created_at,
              CASE WHEN type IN ('topup', 'refund') THEN 'credit' ELSE 'debit' END AS direction
       FROM ledger WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT 50`, [req.user.id]);
    res.json({ balance: Number(bal.rows[0].wallet_balance), transactions: tx.rows, free_cancel_minutes: FREE_CANCEL_MIN, late_penalty_percent: PENALTY_PCT });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch wallet' });
  }
});

// POST /wallet/topup { amount } - SIMULATED payment gateway: the money is added instantly
router.post('/topup', authenticate, async (req, res) => {
  const amount = Math.round(Number(req.body.amount) * 100) / 100;
  if (!Number.isFinite(amount) || amount < 1 || amount > 10000) {
    return res.status(400).json({ error: 'amount must be between 1 and 10000' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const balance = await credit(client, req.user.id, null, amount, 'topup');
    await client.query('COMMIT');
    res.status(201).json({ balance, added: amount });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (e) { /* ignore */ }
    console.error(err);
    res.status(500).json({ error: 'Top-up failed' });
  } finally {
    client.release();
  }
});

// GET /wallet/estimate?charger_id=&vehicle_id=&minutes= - what a booking will hold
router.get('/estimate', authenticate, async (req, res) => {
  const minutes = Math.min(Math.max(parseInt(req.query.minutes, 10) || 60, 15), 480);
  try {
    const p = await pricing(pool, Number(req.query.charger_id), Number(req.query.vehicle_id));
    if (!p) return res.status(404).json({ error: 'Charger or vehicle not found' });
    res.json({ minutes, ...estimate(p, minutes), free_cancel_minutes: FREE_CANCEL_MIN, late_penalty_percent: PENALTY_PCT });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to estimate' });
  }
});

// GET /wallet/earnings - operators: revenue of their stations; admins: all stations
router.get('/earnings', authenticate, requireRole('admin', 'operator'), async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT s.id AS station_id, s.name, s.price_per_kwh,
              COALESCE(SUM(l.amount), 0) AS revenue,
              COUNT(*) FILTER (WHERE l.type = 'final_payment') AS paid_sessions
       FROM stations s
       LEFT JOIN chargers c ON c.station_id = s.id
       LEFT JOIN bookings b ON b.charger_id = c.id
       LEFT JOIN ledger l ON l.booking_id = b.id AND l.type IN ('final_payment', 'penalty')
       WHERE ($1::boolean OR s.operator_id = $2)
       GROUP BY s.id, s.name, s.price_per_kwh ORDER BY s.id`,
      [req.user.role === 'admin', req.user.id]
    );
    const stations = r.rows.map((x) => ({ ...x, revenue: Number(x.revenue), paid_sessions: Number(x.paid_sessions) }));
    res.json({ total: Math.round(stations.reduce((a, x) => a + x.revenue, 0) * 100) / 100, stations });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch earnings' });
  }
});

// GET /wallet/reconcile - admin audit: every wallet balance must equal the sum of its ledger (empty list = all consistent)
router.get('/reconcile', authenticate, requireRole('admin'), async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT * FROM (
         SELECT u.id, u.email, u.wallet_balance,
                COALESCE(SUM(CASE WHEN l.type IN ('topup','refund') THEN l.amount
                                  WHEN l.type IN ('deposit','final_payment','penalty') THEN -l.amount END), 0) AS ledger_balance
         FROM users u LEFT JOIN ledger l ON l.user_id = u.id GROUP BY u.id
       ) t WHERE wallet_balance <> ledger_balance`);
    res.json({ consistent: r.rows.length === 0, mismatches: r.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to reconcile' });
  }
});

module.exports = router;
