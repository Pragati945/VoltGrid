const express = require('express');
const pool = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const router = express.Router();
router.get('/', authenticate, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM stations ORDER BY id');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch stations' });
  }
});
router.get('/:id', authenticate, async (req, res) => {
  try {
    const station = await pool.query('SELECT * FROM stations WHERE id = $1', [req.params.id]);
    if (station.rows.length === 0) {
      return res.status(404).json({ error: 'Station not found' });
    }
    const chargers = await pool.query('SELECT * FROM chargers WHERE station_id = $1', [
      req.params.id,
    ]);
    res.json({ ...station.rows[0], chargers: chargers.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch station' });
  }
});
router.post('/', authenticate, requireRole('admin', 'operator'), async (req, res) => {
  const { name, latitude, longitude, address } = req.body;
  if (!name) {
    return res.status(400).json({ error: 'name is required' });
  }
  try {
    const result = await pool.query(
      `INSERT INTO stations (name, operator_id, latitude, longitude, address)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [name, req.user.id, latitude || null, longitude || null, address || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create station' });
  }
});
router.delete('/:id', authenticate, requireRole('admin'), async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM stations WHERE id = $1 RETURNING id', [
      req.params.id,
    ]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Station not found' });
    }
    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete station' });
  }
});
module.exports = router;
