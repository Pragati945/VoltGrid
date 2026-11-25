const express = require('express');
const pool = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { credit, debit } = require('../payments');

const router = express.Router();

// GET /ledger - the logged-in user's own transactions (admins see all)
router.get('/', authenticate, async (req, res) => {
  try {
    const result = req.user.role === 'admin'
      ? await pool.query('SELECT * FROM ledger ORDER BY created_at DESC')
      : await pool.query('SELECT * FROM ledger WHERE user_id = $1 ORDER BY created_at DESC', [req.user.id]);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch ledger' });
  }
});

// POST /ledger - admin only: manual adjustment. It also moves the wallet, so balance and ledger never disagree.
router.post('/', authenticate, requireRole('admin'), async (req, res) => {
  const { user_id, booking_id, type } = req.body;
  const amount = Math.round(Number(req.body.amount) * 100) / 100;
  const credits = ['topup', 'refund'], debits = ['deposit', 'final_payment', 'penalty'];

  if (!user_id || !Number.isFinite(amount) || amount <= 0 || ![...credits, ...debits].includes(type)) {
    return res.status(400).json({ error: 'user_id, a positive amount, and type (topup, refund, deposit, final_payment, penalty) are required' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const balance = credits.includes(type)
      ? await credit(client, user_id, booking_id || null, amount, type)
      : await debit(client, user_id, booking_id || null, amount, type);
    if (balance === null) {
      await client.query('ROLLBACK');
      return res.status(402).json({ error: 'The user does not have enough balance for this debit' });
    }
    await client.query('COMMIT');
    res.status(201).json({ ok: true, balance });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (e) { /* ignore */ }
    if (err.code === '23503') return res.status(404).json({ error: 'user_id or booking_id does not exist' });
    console.error(err);
    res.status(500).json({ error: 'Failed to create ledger entry' });
  } finally {
    client.release();
  }
});

module.exports = router;
