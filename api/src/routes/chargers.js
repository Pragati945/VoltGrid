const express = require('express');
const pool = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { emitSafe } = require('../socket');
const { ownsStation, ownsCharger } = require('../ownership');
const router = express.Router();
router.get('/', authenticate, async (req, res) => {
  try {
    const { station_id } = req.query;
    const result = station_id
      ? await pool.query('SELECT * FROM chargers WHERE station_id = $1 ORDER BY id', [station_id])
      : await pool.query('SELECT * FROM chargers ORDER BY id');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch chargers' });
  }
});
router.post('/', authenticate, requireRole('admin', 'operator'), async (req, res) => {
  const { station_id, connector_type, power_rating_kw } = req.body;
  if (!station_id || !connector_type || !power_rating_kw) {
    return res
      .status(400)
      .json({ error: 'station_id, connector_type, and power_rating_kw are required' });
  }
  try {
    if (!(await ownsStation(req.user, station_id))) {
      return res.status(403).json({ error: 'You can only add chargers to your own stations' });
    }
    const result = await pool.query(
      `INSERT INTO chargers (station_id, connector_type, power_rating_kw)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [station_id, connector_type, power_rating_kw]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create charger' });
  }
});
router.patch('/:id/status', authenticate, requireRole('admin', 'operator'), async (req, res) => {
  const { status } = req.body;
  const allowed = ['available', 'occupied', 'faulted', 'offline'];
  if (!allowed.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${allowed.join(', ')}` });
  }
  try {
    if (!(await ownsCharger(req.user, req.params.id))) {
      return res.status(403).json({ error: 'You can only change chargers at your own stations' });
    }
    const result = await pool.query(
      'UPDATE chargers SET status = $1, updated_at = now() WHERE id = $2 RETURNING *',
      [status, req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Charger not found' });
    }
    emitSafe('charger:updated', result.rows[0]);
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update charger status' });
  }
});
module.exports = router;
