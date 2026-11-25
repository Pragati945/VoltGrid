const express = require('express');
const pool = require('../db');
const { authenticate } = require('../middleware/auth');
const { emitSafe } = require('../socket');
const { ownsCharger } = require('../ownership');
const { schedule } = require('../scheduler');
const { holdDeposit, settleCompletion, settleCancellation, isLateCancel } = require('../payments');
const { rebalance, rebalanceForCharger, lockStationForBooking, requestPower, finalizeSession } = require('../power');

const router = express.Router();

const GRACE_MS = 5 * 60 * 1000;          // a start time within 5 min of now counts as "right now"
const EARLY_START_MS = 15 * 60 * 1000;   // drivers may start charging up to 15 min before their slot
const isImmediate = (t) => new Date(t).getTime() <= Date.now() + GRACE_MS;

// Owner of the booking, admin, or the operator whose station the charger belongs to
async function mayManage(client, user, b) {
  if (user.role === 'admin' || b.user_id === user.id) return true;
  if (user.role !== 'operator') return false;
  return ownsCharger(user, b.charger_id, client);
}

async function safeRollback(client) {
  try { await client.query('ROLLBACK'); } catch (e) { console.error('ROLLBACK failed:', e); }
}

// GET /bookings - drivers see their own; admins/operators see all
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

/**
 * POST /bookings  { vehicle_id, charger_id, start_time, duration_minutes? (15-480, default 60) }
 * Books a TIME SLOT [start, start+duration). One transaction: lock the charger row,
 * reject if the slot overlaps another confirmed/active booking, insert.
 * - Slot starting now: charger becomes 'occupied' immediately (as before).
 * - Future slot: charger stays 'available' until the driver starts charging.
 * The exclusion constraint no_overlapping_bookings is the database-level backstop.
 */
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
    if (immediate) {
      // A driver has been offered this charger and is deciding: don't let anyone grab it meanwhile
      const held = await client.query("SELECT 1 FROM charger_offers WHERE charger_id = $1 AND status = 'pending' AND expires_at > now() LIMIT 1", [charger_id]);
      if (held.rows.length > 0) {
        await safeRollback(client);
        return res.status(409).json({ error: 'This charger is being held for another driver for a few minutes' });
      }
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

    // Money: hold a deposit for the estimated cost. Same transaction as the booking, so both succeed or neither does.
    const hold = await holdDeposit(client, booking.rows[0]);
    if (hold.insufficient) {
      await safeRollback(client);
      return res.status(402).json({
        error: `Insufficient wallet balance: this booking needs a deposit of Rs ${hold.needed} and your balance is Rs ${hold.balance}. Top up in the Wallet tab.`,
        needed: hold.needed, balance: hold.balance,
      });
    }

    if (immediate) {
      await client.query("UPDATE chargers SET status = 'occupied', updated_at = now() WHERE id = $1", [charger_id]);
    }
    await client.query('COMMIT');

    emitSafe('booking:created', booking.rows[0]);
    if (immediate) emitSafe('charger:updated', { id: charger.id, station_id: charger.station_id, status: 'occupied' });

    res.status(201).json({ ...booking.rows[0], deposit: hold.amount, wallet_balance: hold.balance });
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

// PATCH /bookings/:id/start - driver arrives and asks to start charging (slot starts within 15 min, or already started).
// The station has a limited power budget. The power manager (Banker's-algorithm safety check) decides how many kW this
// session gets: it may start throttled, or wait for power (HTTP 202) and be started automatically when power frees up.
router.patch('/:id/start', authenticate, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await lockStationForBooking(client, req.params.id); // one power decision per station at a time, taken before any row lock

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

    await requestPower(client, b);                                              // record the claim, mark "waiting for power"
    const out = await rebalance(client, charger.station_id, { skipNotify: b.id }); // may start this session right now
    const mine = (await client.query('SELECT * FROM bookings WHERE id = $1', [b.id])).rows[0];
    await client.query('COMMIT');
    out.emit();

    if (mine.status === 'active') return res.json(mine);
    res.status(202).json({
      ...mine, waiting_for_power: true,
      message: "The station's power budget is fully used right now. You are in line for power and charging will start automatically.",
    });
  } catch (err) {
    await safeRollback(client);
    console.error(err);
    res.status(500).json({ error: 'Failed to start booking' });
  } finally {
    client.release();
  }
});

// Shared logic for complete / cancel
async function closeBooking(req, res, { event, newStatus, allowedFrom, completing, failMsg }) {
  const client = await pool.connect();
  let freedCharger = null;
  try {
    await client.query('BEGIN');
    await lockStationForBooking(client, req.params.id); // power lock first, then row locks (same order everywhere)

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

    // Completing records the real end, but never extends past the slot (keeps slots non-overlapping)
    const updated = await client.query(
      completing
        ? `UPDATE bookings SET status = $1,
             end_time = GREATEST(start_time, LEAST(now(), COALESCE(end_time, now())))
           WHERE id = $2 RETURNING *`
        : 'UPDATE bookings SET status = $1 WHERE id = $2 RETURNING *',
      [newStatus, b.id]
    );

    // Money: finishing (or cancelling mid-charge) bills the minutes actually charged; cancelling before charging refunds
    const finalized = await finalizeSession(client, b.id); // stop the energy meter and release this session's power
    const payment = (completing || b.status === 'active')
      ? await settleCompletion(client, finalized || updated.rows[0])
      : await settleCancellation(client, b, isLateCancel(b));

    // Free the charger only if this booking was holding it, and nobody else is actively using it
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
    // Power was just released: let waiting and throttled sessions at this station use it
    const power = await rebalanceForCharger(client, b.charger_id);
    await client.query('COMMIT');

    emitSafe(event, updated.rows[0]);
    if (freedCharger) emitSafe('charger:updated', freedCharger);
    power.emit();
    res.json({ ...updated.rows[0], payment });

    // A charger just freed up: let the scheduler give it to the next waiting vehicle
    if (freedCharger) schedule(freedCharger.station_id);
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
