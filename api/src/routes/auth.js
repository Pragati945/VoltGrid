const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
require('dotenv').config();
const pool = require('../db');
const router = express.Router();
function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
  );
}
async function rollback(client) {
  try { await client.query('ROLLBACK'); } catch (e) { console.error('ROLLBACK failed:', e); }
}
router.post('/register', async (req, res) => {
  const { name, email, password, role, operator_code } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'name, email, and password are required' });
  }
  if (typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: 'password must be at least 8 characters' });
  }
  if (role !== undefined && !['driver', 'operator'].includes(role)) {
    return res.status(400).json({ error: "role must be 'driver' or 'operator'" });
  }
  const finalRole = role === 'operator' ? 'operator' : 'driver';
  if (finalRole === 'operator' && !operator_code) {
    return res.status(403).json({ error: 'Operators need an invite code from an admin' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      await rollback(client);
      return res.status(409).json({ error: 'A user with this email already exists' });
    }
    const passwordHash = await bcrypt.hash(password, 10);
    const inserted = await client.query(
      `INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4)
       RETURNING id, name, email, role, created_at`,
      [name, email, passwordHash, finalRole]
    );
    const user = inserted.rows[0];
    if (finalRole === 'operator') {
      const claim = await client.query(
        `UPDATE operator_invites SET used_by = $1, used_at = now()
         WHERE code = $2 AND used_by IS NULL AND NOT revoked AND expires_at > now() RETURNING id`,
        [user.id, String(operator_code).trim().toUpperCase()]
      );
      if (claim.rows.length === 0) {
        await rollback(client);
        return res.status(403).json({ error: 'Invite code is invalid, already used, revoked or expired' });
      }
    }
    await client.query('COMMIT');
    res.status(201).json({ user, token: signToken(user) });
  } catch (err) {
    await rollback(client);
    if (err.code === '23505') return res.status(409).json({ error: 'A user with this email already exists' });
    console.error(err);
    res.status(500).json({ error: 'Failed to register user' });
  } finally {
    client.release();
  }
});
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }
  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    res.json({
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
      token: signToken(user),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to log in' });
  }
});
module.exports = router;
