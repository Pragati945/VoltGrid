const express = require('express');
const pool = require('../db');
const { authenticate } = require('../middleware/auth');
const { emitSafe } = require('../socket');
const { ownsCharger } = require('../ownership');
const router = express.Router();
const GRACE_MS = 5 * 60 * 1000;         
const EARLY_START_MS = 15 * 60 * 1000; 
const isImmediate = (t) => new Date(t).getTime() <= Date.now() + GRACE_MS;
async function mayManage(client, user, b) {
  if (user.role === 'admin' || b.user_id === user.id) return true;
  if (user.role !== 'operator') return false;
  return ownsCharger(user, b.charger_id, client);
}
async function safeRollback(client) {
  try { await client.query('ROLLBACK'); } catch (e) { console.error('ROLLBACK failed:', e); }
}
router.get('/', authenticate, async (req, res) => {
  try {
    const role = req.user.role;
    const result = role === 'admin'
      ? await pool.query('SELECT * FROM bookings ORDER BY start_time DESC')
      : role === 'operator'
        ? await pool.query(
            `SELECT b.* FROM bookings b JOIN chargers c ON c.id = b.charger_id JOIN stations s ON s.id = c.station_id
             WHERE s.operator_id = $1 OR b.user_id = $1 ORDER BY b.start_time DESC`, [req.user.id])
        : await pool.query('SELECT * FROM bookings WHERE user_id = $1 ORDER BY start_time DESC', [req.user.id]);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch bookings' });
  }
});
router.post('/', authenticate, async (req, res) => {
  const { vehicle_id, charger_id, start_time } = req.body;
  const duration = Number(req.body.duration_minutes ?? 60);
  if (!vehicle_id || !charger_id || !start_time) {
    return res.status(400).json({ error: 'vehicle_id, charger_id, and start_time are required' });
  }
  const start = new Date(start_time);
  if (Number.isNaN(start.getTime())) {
    return res.status(400).json({ error: 'start_time must be a valid ISO date-time' });
  }
  if (!Number.isFinite(duration) || duration < 15 || duration > 480) {
    return res.status(400).json({ error: 'duration_minutes must be between 15 and 480' });
  }
  if (start.getTime() < Date.now() - GRACE_MS) {
    return res.status(400).json({ error: 'start_time cannot be in the past' });
  }
  const end = new Date(start.getTime() + duration * 60000);
  const immediate = isImmediate(start);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ch = await client.query('SELECT id, status, station_id FROM chargers WHERE id = $1 FOR UPDATE', [charger_id]);
    if (ch.rows.length === 0) {
      await safeRollback(client);
      return res.status(404).json({ error: 'Charger not found' });
    }
    const charger = ch.rows[0];
    if (['faulted', 'offline'].includes(charger.status)) {
      await safeRollback(client);
      return res.status(409).json({ error: `Charger is ${charger.status}` });
    }
    if (immediate && charger.status !== 'available') {
      await safeRollback(client);
      return res.status(409).json({ error: 'Charger is not available right now. Pick a later start time.' });
    }
    const vehicle = await client.query('SELECT id, user_id FROM vehicles WHERE id = $1', [vehicle_id]);
    if (vehicle.rows.length === 0) {
      await safeRollback(client);
      return res.status(404).json({ error: 'Vehicle not found' });
    }
    if (req.user.role !== 'admin' && vehicle.rows[0].user_id !== req.user.id) {
      await safeRollback(client);
      return res.status(403).json({ error: 'This vehicle does not belong to you' });
    }
    const clash = await client.query(
      `SELECT start_time, end_time FROM bookings
       WHERE charger_id = $1 AND status IN ('confirmed', 'active')
         AND tstzrange(start_time, COALESCE(end_time, 'infinity')) && tstzrange($2::timestamptz, $3::timestamptz)
       LIMIT 1`,
      [charger_id, start, end]
    );
    if (clash.rows.length > 0) {
      await safeRollback(client);
      return res.status(409).json({
        error: 'Charger is already booked for part of that time',
        busy_from: clash.rows[0].start_time,
        busy_until: clash.rows[0].end_time,
      });
    }
    const booking = await client.query(
      `INSERT INTO bookings (user_id, vehicle_id, charger_id, status, start_time, end_time)
       VALUES ($1, $2, $3, 'confirmed', $4, $5) RETURNING *`,
      [req.user.id, vehicle_id, charger_id, start, end]
    );
    if (immediate) {
      await client.query("UPDATE chargers SET status = 'occupied', updated_at = now() WHERE id = $1", [charger_id]);
    }
    await client.query('COMMIT');
    emitSafe('booking:created', booking.rows[0]);
    if (immediate) emitSafe('charger:updated', { id: charger.id, station_id: charger.station_id, status: 'occupied' });
    res.status(201).json(booking.rows[0]);
  } catch (err) {
    await safeRollback(client);
    if (err.code === '23P01' || err.code === '23505') {
      return res.status(409).json({ error: 'Charger is already booked for part of that time' });
    }
    console.error(err);
    res.status(500).json({ error: 'Failed to create booking' });
  } finally {
    client.release();
  }
});
router.patch('/:id/start', authenticate, async (req, res) => {
  const client = await pool.connect();
  let changedCharger = null;
  try {
    await client.query('BEGIN');
    const found = await client.query('SELECT * FROM bookings WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (found.rows.length === 0) {
      await safeRollback(client);
      return res.status(404).json({ error: 'Booking not found' });
    }
    const b = found.rows[0];
    if (!(await mayManage(client, req.user, b))) {
      await safeRollback(client);
      return res.status(403).json({ error: 'This is not your booking' });
    }
    if (b.status !== 'confirmed') {
      await safeRollback(client);
      return res.status(409).json({ error: `Booking is ${b.status}, only confirmed bookings can start` });
    }
    if (new Date(b.start_time).getTime() > Date.now() + EARLY_START_MS) {
      await safeRollback(client);
      return res.status(409).json({ error: 'Too early to start. You can start up to 15 minutes before your slot.', starts_at: b.start_time });
    }
    const ch = await client.query('SELECT id, status, station_id FROM chargers WHERE id = $1 FOR UPDATE', [b.charger_id]);
    const charger = ch.rows[0];
    if (['faulted', 'offline'].includes(charger.status)) {
      await safeRollback(client);
      return res.status(409).json({ error: `Charger is ${charger.status}` });
    }
    const other = await client.query(
      "SELECT 1 FROM bookings WHERE charger_id = $1 AND status = 'active' AND id <> $2 LIMIT 1",
      [b.charger_id, b.id]
    );
    if (other.rows.length > 0) {
      await safeRollback(client);
      return res.status(409).json({ error: 'Charger is still in use by an earlier booking' });
    }
    const updated = await client.query("UPDATE bookings SET status = 'active' WHERE id = $1 RETURNING *", [b.id]);
    if (charger.status === 'available') {
      await client.query("UPDATE chargers SET status = 'occupied', updated_at = now() WHERE id = $1", [charger.id]);
      changedCharger = { id: charger.id, station_id: charger.station_id, status: 'occupied' };
    }
    await client.query('COMMIT');
    emitSafe('booking:started', updated.rows[0]);
    if (changedCharger) emitSafe('charger:updated', changedCharger);
    res.json(updated.rows[0]);
  } catch (err) {
    await safeRollback(client);
    console.error(err);
    res.status(500).json({ error: 'Failed to start booking' });
  } finally {
    client.release();
  }
});
async function closeBooking(req, res, { event, newStatus, allowedFrom, completing, failMsg }) {
  const client = await pool.connect();
  let freedCharger = null;
  try {
    await client.query('BEGIN');
    const found = await client.query('SELECT * FROM bookings WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (found.rows.length === 0) {
      await safeRollback(client);
      return res.status(404).json({ error: 'Booking not found' });
    }
    const b = found.rows[0];
    if (!(await mayManage(client, req.user, b))) {
      await safeRollback(client);
      return res.status(403).json({ error: 'This is not your booking' });
    }
    if (!allowedFrom.includes(b.status)) {
      await safeRollback(client);
      return res.status(409).json({ error: `Booking is already ${b.status}` });
    }
    const updated = await client.query(
      completing
        ? `UPDATE bookings SET status = $1,
             end_time = GREATEST(start_time, LEAST(now(), COALESCE(end_time, now())))
           WHERE id = $2 RETURNING *`
        : 'UPDATE bookings SET status = $1 WHERE id = $2 RETURNING *',
      [newStatus, b.id]
    );
    const holding = b.status === 'active' || (b.status === 'confirmed' && isImmediate(b.start_time));
    if (holding) {
      const freed = await client.query(
        `UPDATE chargers SET status = 'available', updated_at = now()
         WHERE id = $1 AND status = 'occupied'
           AND NOT EXISTS (SELECT 1 FROM bookings WHERE charger_id = $1 AND status = 'active' AND id <> $2)
         RETURNING id, station_id, status`,
        [b.charger_id, b.id]
      );
      freedCharger = freed.rows[0] || null;
    }
    await client.query('COMMIT');
    emitSafe(event, updated.rows[0]);
    if (freedCharger) emitSafe('charger:updated', freedCharger);
    res.json(updated.rows[0]);
  } catch (err) {
    await safeRollback(client);
    console.error(err);
    res.status(500).json({ error: failMsg });
  } finally {
    client.release();
  }
}
router.patch('/:id/complete', authenticate, (req, res) =>
  closeBooking(req, res, { event: 'booking:completed', newStatus: 'completed', allowedFrom: ['confirmed', 'active'], completing: true, failMsg: 'Failed to complete booking' })
);
router.patch('/:id/cancel', authenticate, (req, res) =>
  closeBooking(req, res, { event: 'booking:cancelled', newStatus: 'cancelled', allowedFrom: ['pending', 'confirmed', 'active'], completing: false, failMsg: 'Failed to cancel booking' })
);
module.exports = router;
