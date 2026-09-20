const express = require('express');
const pool = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');

const router = express.Router();

// GET /ledger - the logged-in user's own transactions (admins see all)
router.get('/', authenticate, async (req, res) => {
  try {
    const query =
      req.user.role === 'admin'
        ? 'SELECT * FROM ledger ORDER BY created_at DESC'
        : 'SELECT * FROM ledger WHERE user_id = $1 ORDER BY created_at DESC';
    const params = req.user.role === 'admin' ? [] : [req.user.id];

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch ledger' });
  }
});

// POST /ledger - admin only (mock deposit/final_payment/refund/penalty entry)
router.post('/', authenticate, requireRole('admin'), async (req, res) => {
  const { user_id, booking_id, amount, type } = req.body;
  const allowedTypes = ['deposit', 'final_payment', 'refund', 'penalty'];

  if (!user_id || !amount || !allowedTypes.includes(type)) {
    return res
      .status(400)
      .json({ error: `user_id, amount, and type (one of: ${allowedTypes.join(', ')}) are required` });
  }

  try {
    const result = await pool.query(
      `INSERT INTO ledger (user_id, booking_id, amount, type)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [user_id, booking_id || null, amount, type]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create ledger entry' });
  }
});

module.exports = router;
