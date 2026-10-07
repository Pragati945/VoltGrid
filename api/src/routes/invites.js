const express = require('express');
const crypto = require('crypto');
const pool = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const router = express.Router();
router.use(authenticate, requireRole('admin'));
router.get('/', async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT id, code, note, created_at, expires_at, used_by, used_at, revoked FROM operator_invites ORDER BY created_at DESC'
    );
    res.json(r.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch invites' });
  }
});
router.post('/', async (req, res) => {
  const note = String(req.body.note || '').slice(0, 100);
  const days = Math.min(Math.max(parseInt(req.body.days, 10) || 7, 1), 90);
  const code = 'VG-' + crypto.randomBytes(5).toString('hex').toUpperCase();
  try {
    const r = await pool.query(
      `INSERT INTO operator_invites (code, note, created_by, expires_at)
       VALUES ($1, $2, $3, now() + make_interval(days => $4)) RETURNING *`,
      [code, note, req.user.id, days]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create invite' });
  }
});
router.delete('/:id', async (req, res) => {
  try {
    const r = await pool.query(
      'UPDATE operator_invites SET revoked = true WHERE id = $1 AND used_by IS NULL RETURNING id',
      [req.params.id]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Invite not found or already used' });
    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to revoke invite' });
  }
});
module.exports = router;
