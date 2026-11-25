const express = require('express');
const pool = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { ownsStation } = require('../ownership');

const router = express.Router();

// GET /stations - public to any logged-in user
router.get('/', authenticate, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM stations ORDER BY id');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch stations' });
  }
});

// GET /stations/:id - includes its chargers
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

// POST /stations - admin or operator only
router.post('/', authenticate, requireRole('admin', 'operator'), async (req, res) => {
  const { name, latitude, longitude, address } = req.body;
  if (!name) {
    return res.status(400).json({ error: 'name is required' });
  }
  const price = req.body.price_per_kwh === undefined || req.body.price_per_kwh === '' ? 18 : Number(req.body.price_per_kwh);
  if (!Number.isFinite(price) || price < 1 || price > 200) {
    return res.status(400).json({ error: 'price_per_kwh must be between 1 and 200' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO stations (name, operator_id, latitude, longitude, address, price_per_kwh)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [name, req.user.id, latitude || null, longitude || null, address || null, price]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create station' });
  }
});

// PATCH /stations/:id/price - the station's operator (or an admin) sets the price per kWh
router.patch('/:id/price', authenticate, requireRole('admin', 'operator'), async (req, res) => {
  const price = Number(req.body.price_per_kwh);
  if (!Number.isFinite(price) || price < 1 || price > 200) {
    return res.status(400).json({ error: 'price_per_kwh must be between 1 and 200' });
  }
  try {
    if (!(await ownsStation(req.user, req.params.id))) {
      return res.status(403).json({ error: 'You can only change prices at your own stations' });
    }
    const r = await pool.query('UPDATE stations SET price_per_kwh = $1 WHERE id = $2 RETURNING *', [price, req.params.id]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Station not found' });
    res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update price' });
  }
});

// DELETE /stations/:id - admin only
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
