const express = require('express');
const pool = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');

const router = express.Router();

// GET /bookings - the logged-in user's own bookings (admins/operators see all)
router.get('/', authenticate, async (req, res) => {
  try {
    const query =
      req.user.role === 'driver'
        ? 'SELECT * FROM bookings WHERE user_id = $1 ORDER BY created_at DESC'
        : 'SELECT * FROM bookings ORDER BY created_at DESC';
    const params = req.user.role === 'driver' ? [req.user.id] : [];

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch bookings' });
  }
});

/**
 * POST /bookings
 * This is the "ACID Engine" from the proposal: it wraps the charger check
 * and the booking insert in a single transaction, and uses
 * `SELECT ... FOR UPDATE` to lock the charger row for the duration of the
 * transaction. If two requests hit this at the same time, the second one
 * blocks until the first commits or rolls back — so only one can ever
 * succeed in booking a given charger. This is what guarantees no
 * double-bookings under concurrent load.
 */
router.post('/', authenticate, async (req, res) => {
  const { vehicle_id, charger_id, start_time } = req.body;

  if (!vehicle_id || !charger_id || !start_time) {
    return res.status(400).json({ error: 'vehicle_id, charger_id, and start_time are required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock the charger row so no other transaction can read/act on it
    // until this one finishes.
    const chargerResult = await client.query(
      'SELECT id, status FROM chargers WHERE id = $1 FOR UPDATE',
      [charger_id]
    );

    if (chargerResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Charger not found' });
    }

    if (chargerResult.rows[0].status !== 'available') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Charger is not available for booking' });
    }

    const vehicleCheck = await client.query('SELECT id FROM vehicles WHERE id = $1 AND user_id = $2', [
      vehicle_id,
      req.user.id,
    ]);
    if (vehicleCheck.rows.length === 0 && req.user.role === 'driver') {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'This vehicle does not belong to you' });
    }

    const bookingResult = await client.query(
      `INSERT INTO bookings (user_id, vehicle_id, charger_id, status, start_time)
       VALUES ($1, $2, $3, 'confirmed', $4)
       RETURNING *`,
      [req.user.id, vehicle_id, charger_id, start_time]
    );

    await client.query('UPDATE chargers SET status = $1, updated_at = now() WHERE id = $2', [
      'occupied',
      charger_id,
    ]);

    await client.query('COMMIT');
    res.status(201).json(bookingResult.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Failed to create booking' });
  } finally {
    client.release();
  }
});

// PATCH /bookings/:id/complete - ends a booking and frees the charger
router.patch('/:id/complete', authenticate, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const booking = await client.query('SELECT * FROM bookings WHERE id = $1 FOR UPDATE', [
      req.params.id,
    ]);
    if (booking.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Booking not found' });
    }
    if (req.user.role === 'driver' && booking.rows[0].user_id !== req.user.id) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'This is not your booking' });
    }

    const updated = await client.query(
      `UPDATE bookings SET status = 'completed', end_time = now() WHERE id = $1 RETURNING *`,
      [req.params.id]
    );

    await client.query('UPDATE chargers SET status = $1, updated_at = now() WHERE id = $2', [
      'available',
      booking.rows[0].charger_id,
    ]);

    await client.query('COMMIT');
    res.json(updated.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Failed to complete booking' });
  } finally {
    client.release();
  }
});

// PATCH /bookings/:id/cancel
router.patch('/:id/cancel', authenticate, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const booking = await client.query('SELECT * FROM bookings WHERE id = $1 FOR UPDATE', [
      req.params.id,
    ]);
    if (booking.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Booking not found' });
    }
    if (req.user.role === 'driver' && booking.rows[0].user_id !== req.user.id) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'This is not your booking' });
    }

    const updated = await client.query(
      `UPDATE bookings SET status = 'cancelled' WHERE id = $1 RETURNING *`,
      [req.params.id]
    );

    if (['confirmed', 'active'].includes(booking.rows[0].status)) {
      await client.query('UPDATE chargers SET status = $1, updated_at = now() WHERE id = $2', [
        'available',
        booking.rows[0].charger_id,
      ]);
    }

    await client.query('COMMIT');
    res.json(updated.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Failed to cancel booking' });
  } finally {
    client.release();
  }
});

module.exports = router;
