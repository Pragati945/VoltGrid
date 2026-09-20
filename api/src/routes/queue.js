const express = require('express');
const pool = require('../db');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// GET /queue?station_id=1 - ordered by priority (emergency vehicles first), then FIFO
router.get('/', authenticate, async (req, res) => {
  try {
    const { station_id } = req.query;
    const query = `
      SELECT q.*, v.is_emergency, v.vehicle_model
      FROM queue q
      JOIN vehicles v ON v.id = q.vehicle_id
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

// POST /queue - join the waiting list for a station
router.post('/', authenticate, async (req, res) => {
  const { station_id, vehicle_id } = req.body;
  if (!station_id || !vehicle_id) {
    return res.status(400).json({ error: 'station_id and vehicle_id are required' });
  }

  try {
    // Emergency vehicles automatically get top priority (level 10 vs 0)
    const vehicle = await pool.query('SELECT is_emergency FROM vehicles WHERE id = $1', [
      vehicle_id,
    ]);
    if (vehicle.rows.length === 0) {
      return res.status(404).json({ error: 'Vehicle not found' });
    }
    const priority = vehicle.rows[0].is_emergency ? 10 : 0;

    const result = await pool.query(
      `INSERT INTO queue (station_id, vehicle_id, priority_level, status)
       VALUES ($1, $2, $3, 'waiting')
       RETURNING *`,
      [station_id, vehicle_id, priority]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to join queue' });
  }
});

// PATCH /queue/:id/cancel
router.patch('/:id/cancel', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE queue SET status = 'expired' WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Queue entry not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to cancel queue entry' });
  }
});

module.exports = router;
