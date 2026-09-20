const express = require('express');
const pool = require('../db');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// GET /telemetry/charger/:chargerId/latest - most recent reading for one charger
router.get('/charger/:chargerId/latest', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM telemetry WHERE charger_id = $1 ORDER BY recorded_at DESC LIMIT 1`,
      [req.params.chargerId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No telemetry recorded for this charger yet' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch telemetry' });
  }
});

// GET /telemetry/charger/:chargerId/history?limit=50
router.get('/charger/:chargerId/history', authenticate, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 500);
  try {
    const result = await pool.query(
      `SELECT * FROM telemetry WHERE charger_id = $1 ORDER BY recorded_at DESC LIMIT $2`,
      [req.params.chargerId, limit]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch telemetry history' });
  }
});

// POST /telemetry - the Telemetry Engine (simulator) reports a new reading
router.post('/', authenticate, async (req, res) => {
  const { charger_id, booking_id, power_draw_kw, battery_soc, temperature_c } = req.body;
  if (!charger_id) {
    return res.status(400).json({ error: 'charger_id is required' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO telemetry (charger_id, booking_id, power_draw_kw, battery_soc, temperature_c)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [charger_id, booking_id || null, power_draw_kw || null, battery_soc || null, temperature_c || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to record telemetry' });
  }
});

module.exports = router;
