const express = require('express');
const pool = require('../db');
const { authenticate } = require('../middleware/auth');
const { emitSafe } = require('../socket');
const { ownsStation } = require('../ownership');
const router = express.Router();
router.get('/', authenticate, async (req, res) => {
  try {
    const { station_id } = req.query;
    const query = `
      SELECT q.*, v.is_emergency, m.brand, m.model_name
      FROM queue q
      JOIN vehicles v ON v.id = q.vehicle_id
      JOIN vehicle_models m ON m.id = v.model_id
      WHERE q.status = 'waiting' ${station_id ? 'AND q.station_id = $1' : ''}
      ORDER BY q.priority_level DESC, q.requested_at ASC
    `;
    const result = station_id ? await pool.query(query, [station_id]) : await pool.query(query);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch queue' });
  }
});
router.post('/', authenticate, async (req, res) => {
  const { station_id, vehicle_id } = req.body;
  if (!station_id || !vehicle_id) {
    return res.status(400).json({ error: 'station_id and vehicle_id are required' });
  }
  try {
    const vehicle = await pool.query('SELECT user_id, is_emergency FROM vehicles WHERE id = $1', [vehicle_id]);
    if (vehicle.rows.length === 0) {
      return res.status(404).json({ error: 'Vehicle not found' });
    }
    if (req.user.role !== 'admin' && vehicle.rows[0].user_id !== req.user.id) {
      return res.status(403).json({ error: 'This vehicle does not belong to you' });
    }
    const station = await pool.query('SELECT id FROM stations WHERE id = $1', [station_id]);
    if (station.rows.length === 0) {
      return res.status(404).json({ error: 'Station not found' });
    }
    const dup = await pool.query(
      "SELECT id FROM queue WHERE station_id = $1 AND vehicle_id = $2 AND status = 'waiting'",
      [station_id, vehicle_id]
    );
    if (dup.rows.length > 0) {
      return res.status(409).json({ error: 'Vehicle is already waiting at this station' });
    }
    const priority = vehicle.rows[0].is_emergency ? 10 : 0;
    const result = await pool.query(
      `INSERT INTO queue (station_id, vehicle_id, priority_level, status)
       VALUES ($1, $2, $3, 'waiting')
       RETURNING *`,
      [station_id, vehicle_id, priority]
    );
    emitSafe('queue:updated', { station_id: Number(station_id), action: 'joined', entry: result.rows[0] });
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to join queue' });
  }
});
router.patch('/:id/cancel', authenticate, async (req, res) => {
  try {
    const entry = await pool.query(
      `SELECT q.id, q.status, q.station_id, v.user_id
       FROM queue q JOIN vehicles v ON v.id = q.vehicle_id
       WHERE q.id = $1`,
      [req.params.id]
    );
    if (entry.rows.length === 0) {
      return res.status(404).json({ error: 'Queue entry not found' });
    }
    if (req.user.role === 'driver' && entry.rows[0].user_id !== req.user.id) {
      return res.status(403).json({ error: 'This is not your queue entry' });
    }
    if (req.user.role === 'operator' && entry.rows[0].user_id !== req.user.id &&
        !(await ownsStation(req.user, entry.rows[0].station_id))) {
      return res.status(403).json({ error: 'This station is not yours' });
    }
    if (entry.rows[0].status !== 'waiting') {
      return res.status(409).json({ error: `Queue entry is already ${entry.rows[0].status}` });
    }
    const result = await pool.query(
      "UPDATE queue SET status = 'expired' WHERE id = $1 RETURNING *",
      [req.params.id]
    );
    emitSafe('queue:updated', { station_id: entry.rows[0].station_id, action: 'cancelled', entry: result.rows[0] });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to cancel queue entry' });
  }
});
module.exports = router;
