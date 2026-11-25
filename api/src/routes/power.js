const express = require('express');
const pool = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { ownsStation } = require('../ownership');
const { isSafe, snapshot, rebalanceStation, STEP_KW, MIN_START_KW } = require('../power');

const router = express.Router();

// GET /power/stations - every station's power picture (limit, in use, sessions, waiting list)
router.get('/stations', authenticate, async (req, res) => {
  try {
    const ids = await pool.query('SELECT id FROM stations ORDER BY id');
    const out = [];
    for (const r of ids.rows) out.push(await snapshot(pool, r.id));
    res.json(out);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch power status' });
  }
});

router.get('/stations/:id', authenticate, async (req, res) => {
  try {
    const s = await snapshot(pool, Number(req.params.id));
    if (!s) return res.status(404).json({ error: 'Station not found' });
    res.json({ ...s, step_kw: STEP_KW, min_start_kw: MIN_START_KW });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch power status' });
  }
});

// PATCH /power/stations/:id/limit { power_limit_kw } - the station's operator (or an admin) sets the grid limit
router.patch('/stations/:id/limit', authenticate, requireRole('admin', 'operator'), async (req, res) => {
  const limit = Number(req.body.power_limit_kw);
  if (!Number.isFinite(limit) || limit < 10 || limit > 5000) {
    return res.status(400).json({ error: 'power_limit_kw must be between 10 and 5000' });
  }
  try {
    if (!(await ownsStation(req.user, req.params.id))) {
      return res.status(403).json({ error: 'You can only change the power limit of your own stations' });
    }
    const r = await pool.query('UPDATE stations SET power_limit_kw = $1 WHERE id = $2 RETURNING id', [limit, req.params.id]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Station not found' });
    await rebalanceStation(pool, Number(req.params.id)); // a higher limit starts waiting sessions straight away
    res.json(await snapshot(pool, Number(req.params.id)));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update power limit' });
  }
});

// POST /power/banker { capacity, sessions: [{name, max, alloc}] } - run the safety algorithm on any state (teaching tool)
router.post('/banker', authenticate, (req, res) => {
  const cap = Number(req.body.capacity), list = req.body.sessions;
  const okNum = (x) => Number.isFinite(x) && x >= 0 && x <= 100000;
  if (!okNum(cap) || !Array.isArray(list) || list.length < 1 || list.length > 20 ||
      !list.every((s) => okNum(Number(s.max)) && okNum(Number(s.alloc)) && Number(s.alloc) <= Number(s.max))) {
    return res.status(400).json({ error: 'capacity and 1-20 sessions with 0 <= alloc <= max are required' });
  }
  const sessions = list.map((s, i) => ({ id: i, name: s.name || 'S' + (i + 1), max: Number(s.max), alloc: Number(s.alloc) }));
  const r = isSafe(cap, sessions);
  res.json({
    capacity: cap, available: r.available, safe: r.safe,
    sequence: r.sequence.map((i) => sessions[i].name),
    needs: sessions.map((s) => ({ name: s.name, max: s.max, alloc: s.alloc, need: s.max - s.alloc })),
  });
});

module.exports = router;
