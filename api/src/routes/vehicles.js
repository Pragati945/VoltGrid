const express = require('express');
const pool = require('../db');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// GET /vehicles - the logged-in user's own vehicles (admins see all)
router.get('/', authenticate, async (req, res) => {
  try {
    const query =
      req.user.role === 'admin'
        ? 'SELECT * FROM vehicles ORDER BY id'
        : 'SELECT * FROM vehicles WHERE user_id = $1 ORDER BY id';
    const params = req.user.role === 'admin' ? [] : [req.user.id];

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch vehicles' });
  }
});

// POST /vehicles - register a new vehicle for the logged-in user
router.post('/', authenticate, async (req, res) => {
  const { vehicle_model, battery_capacity_kwh, connector_type, is_emergency } = req.body;

  if (!battery_capacity_kwh || !connector_type) {
    return res.status(400).json({ error: 'battery_capacity_kwh and connector_type are required' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO vehicles (user_id, vehicle_model, battery_capacity_kwh, connector_type, is_emergency)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [req.user.id, vehicle_model || null, battery_capacity_kwh, connector_type, !!is_emergency]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create vehicle' });
  }
});

// DELETE /vehicles/:id - only the owner or an admin
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const check = await pool.query('SELECT user_id FROM vehicles WHERE id = $1', [req.params.id]);
    if (check.rows.length === 0) {
      return res.status(404).json({ error: 'Vehicle not found' });
    }
    if (req.user.role !== 'admin' && check.rows[0].user_id !== req.user.id) {
      return res.status(403).json({ error: 'You do not own this vehicle' });
    }

    await pool.query('DELETE FROM vehicles WHERE id = $1', [req.params.id]);
    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete vehicle' });
  }
});

module.exports = router;
