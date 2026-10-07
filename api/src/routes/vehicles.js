const express = require('express');
const pool = require('../db');
const { authenticate } = require('../middleware/auth');
const router = express.Router();
router.get('/models', authenticate, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM vehicle_models ORDER BY brand, model_name');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch vehicle models' });
  }
});
router.get('/', authenticate, async (req, res) => {
  try {
    const baseQuery = `
      SELECT v.id, v.user_id, v.is_emergency, v.created_at,
             m.id AS model_id, m.brand, m.model_name,
             m.battery_capacity_kwh, m.connector_type,
             m.max_charge_rate_kw, m.segment
      FROM vehicles v
      JOIN vehicle_models m ON m.id = v.model_id
    `;
    const isAdmin = req.user.role === 'admin';
    const result = isAdmin
      ? await pool.query(`${baseQuery} ORDER BY v.id`)
      : await pool.query(`${baseQuery} WHERE v.user_id = $1 ORDER BY v.id`, [req.user.id]);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch vehicles' });
  }
});
router.post('/', authenticate, async (req, res) => {
  const { model_id, is_emergency } = req.body;
  if (!model_id) {
    return res.status(400).json({ error: 'model_id is required (see GET /vehicles/models)' });
  }
  try {
    const modelCheck = await pool.query('SELECT id FROM vehicle_models WHERE id = $1', [model_id]);
    if (modelCheck.rows.length === 0) {
      return res.status(404).json({ error: 'No vehicle model found with that model_id' });
    }
    const emergency = req.user.role === 'admin' ? !!is_emergency : false;
    const result = await pool.query(
      `INSERT INTO vehicles (user_id, model_id, is_emergency)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [req.user.id, model_id, emergency]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create vehicle' });
  }
});
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
