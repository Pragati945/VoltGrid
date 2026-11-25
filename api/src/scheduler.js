/**
 * VoltGrid scheduler: priority scheduling with aging, delivered as OFFERS.
 *
 * When a charger becomes free, schedule(stationId) offers it (it does NOT assign it silently):
 *   1. First to the best waiting vehicle in the queue: effective priority DESC, then arrival time ASC,
 *      where effective priority = priority_level (emergency 10, normal 0) + 1 per AGING_MIN minutes waited
 *      (aging prevents starvation). The vehicle's connector must fit the charger.
 *   2. Otherwise to a driver whose confirmed booking at this station starts soon: "start now instead?"
 * The driver gets a push message (Socket.IO to their own room) and has OFFER_MIN minutes to accept.
 * Accepting creates/moves the booking and occupies the charger. Declining or timing out re-queues the
 * driver and offers the charger to the next candidate. While an offer is open, nobody else can take that charger.
 * Drivers who accept a queue offer but never start charging are expired after HOLD_MIN minutes (no-show).
 */
const pool = require('./db');
const { emitSafe, emitToUser } = require('./socket');
const { holdDeposit, settleCancellation } = require('./payments');
const { rebalanceStation } = require('./power');

const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : d);
const HOLD_MIN = num(process.env.QUEUE_HOLD_MINUTES, 10);
const SLOT_MIN = num(process.env.QUEUE_SLOT_MINUTES, 60);
const AGING_MIN = num(process.env.QUEUE_AGING_MINUTES, 10);
const OFFER_MIN = num(process.env.OFFER_MINUTES, 5);                   // time to answer an offer
const EARLY_WINDOW_MIN = num(process.env.EARLY_OFFER_WINDOW_MINUTES, 120); // bookings starting within this may be offered "now"
const RETRY_MIN = 30;                                                  // don't re-offer the same charger to the same driver for this long
const TICK_MS = 30000;

const EFFECTIVE = `(q.priority_level + FLOOR(EXTRACT(EPOCH FROM (now() - q.requested_at)) / 60 / ${AGING_MIN}))`;

const OFFER_VIEW = `SELECT o.id, o.source, o.charger_id, o.expires_at, c.station_id, s.name AS station_name,
    c.connector_type, c.power_rating_kw, b.start_time AS booking_start, b.end_time AS booking_end
  FROM charger_offers o JOIN chargers c ON c.id = o.charger_id JOIN stations s ON s.id = c.station_id
  LEFT JOIN bookings b ON b.id = o.booking_id`;

async function rollback(client) { try { await client.query('ROLLBACK'); } catch (e) { console.error('ROLLBACK failed:', e); } }

// Minutes until the next reservation on a charger (Infinity = none). Optionally ignore one booking.
async function gapMinutes(db, chargerId, excludeBookingId = 0) {
  const r = await db.query(
    `SELECT EXTRACT(EPOCH FROM (min(start_time) - now())) / 60 AS mins FROM bookings
     WHERE charger_id = $1 AND status IN ('confirmed', 'active') AND end_time > now() AND id <> $2`,
    [chargerId, excludeBookingId]
  );
  const g = r.rows[0].mins;
  return g === null ? Infinity : Math.floor(Number(g));
}

// Close an offer; a queue entry that was on hold goes back to waiting
async function closeOffer(client, o, status) {
  await client.query('UPDATE charger_offers SET status = $1, responded_at = now() WHERE id = $2', [status, o.id]);
  if (o.queue_id) await client.query("UPDATE queue SET status = 'waiting' WHERE id = $1 AND status = 'promoted'", [o.queue_id]);
}

async function schedule(stationId) {
  const notify = [];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(7001, $1)', [stationId]);

    const free = await client.query(
      `SELECT c.id, c.connector_type FROM chargers c
       WHERE c.station_id = $1 AND c.status = 'available'
         AND NOT EXISTS (SELECT 1 FROM charger_offers o WHERE o.charger_id = c.id AND o.status = 'pending')
       ORDER BY c.id FOR UPDATE OF c`,
      [stationId]
    );

    for (const ch of free.rows) {
      let offer = null;
      const gapAll = await gapMinutes(client, ch.id);

      // 1) the waiting queue
      if (Math.min(SLOT_MIN, gapAll) >= 15) {
        const next = await client.query(
          `SELECT q.id AS queue_id, q.vehicle_id, v.user_id
           FROM queue q JOIN vehicles v ON v.id = q.vehicle_id JOIN vehicle_models m ON m.id = v.model_id
           WHERE q.station_id = $1 AND q.status = 'waiting' AND lower(m.connector_type) = lower($2)
             AND NOT EXISTS (SELECT 1 FROM charger_offers o WHERE o.charger_id = $3 AND o.vehicle_id = q.vehicle_id
                             AND o.created_at > now() - make_interval(mins => $4))
           ORDER BY ${EFFECTIVE} DESC, q.requested_at ASC
           LIMIT 1 FOR UPDATE OF q`,
          [stationId, ch.connector_type, ch.id, RETRY_MIN]
        );
        if (next.rows.length > 0) {
          const e = next.rows[0];
          const ins = await client.query(
            `INSERT INTO charger_offers (charger_id, user_id, vehicle_id, source, queue_id, expires_at)
             VALUES ($1, $2, $3, 'queue', $4, now() + make_interval(mins => $5)) RETURNING id`,
            [ch.id, e.user_id, e.vehicle_id, e.queue_id, OFFER_MIN]
          );
          await client.query("UPDATE queue SET status = 'promoted' WHERE id = $1", [e.queue_id]);
          offer = { id: ins.rows[0].id, user_id: e.user_id };
        }
      }

      // 2) a driver whose confirmed booking here starts soon
      if (!offer) {
        const bk = await client.query(
          `SELECT b.id AS booking_id, b.vehicle_id, b.user_id, b.start_time, b.end_time
           FROM bookings b JOIN chargers bc ON bc.id = b.charger_id
           JOIN vehicles v ON v.id = b.vehicle_id JOIN vehicle_models m ON m.id = v.model_id
           WHERE bc.station_id = $1 AND b.status = 'confirmed'
             AND b.start_time > now() + interval '5 minutes' AND b.start_time <= now() + make_interval(mins => $2)
             AND lower(m.connector_type) = lower($3)
             AND NOT EXISTS (SELECT 1 FROM charger_offers o WHERE o.status = 'pending' AND (o.booking_id = b.id OR o.user_id = b.user_id))
             AND NOT EXISTS (SELECT 1 FROM charger_offers o WHERE o.charger_id = $4 AND o.booking_id = b.id
                             AND o.created_at > now() - make_interval(mins => $5))
           ORDER BY b.start_time ASC LIMIT 1 FOR UPDATE OF b`,
          [stationId, EARLY_WINDOW_MIN, ch.connector_type, ch.id, RETRY_MIN]
        );
        if (bk.rows.length > 0) {
          const b = bk.rows[0];
          const orig = b.end_time ? Math.floor((new Date(b.end_time) - new Date(b.start_time)) / 60000) : SLOT_MIN;
          const gapB = await gapMinutes(client, ch.id, b.booking_id);
          if (Math.min(orig, gapB) >= 15) {
            const ins = await client.query(
              `INSERT INTO charger_offers (charger_id, user_id, vehicle_id, source, booking_id, expires_at)
               VALUES ($1, $2, $3, 'booking', $4, now() + make_interval(mins => $5)) RETURNING id`,
              [ch.id, b.user_id, b.vehicle_id, b.booking_id, OFFER_MIN]
            );
            offer = { id: ins.rows[0].id, user_id: b.user_id };
          }
        }
      }

      if (offer) {
        const view = await client.query(`${OFFER_VIEW} WHERE o.id = $1`, [offer.id]);
        notify.push([offer.user_id, view.rows[0]]);
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await rollback(client);
    notify.length = 0;
    console.error('Scheduler failed for station', stationId, err);
  } finally {
    client.release();
  }
  // Push messages go out only after the commit, and only to the driver concerned
  notify.forEach(([userId, payload]) => {
    emitToUser(userId, 'offer:new', payload);
    emitSafe('queue:updated', { station_id: stationId, action: 'offered' });
  });
  return notify.length;
}

async function pendingOffers(userId) {
  const r = await pool.query(`${OFFER_VIEW} WHERE o.user_id = $1 AND o.status = 'pending' AND o.expires_at > now() ORDER BY o.created_at`, [userId]);
  return r.rows;
}

async function acceptOffer(userId, offerId) {
  const client = await pool.connect();
  const events = [];
  let result, reschedule = null;
  try {
    await client.query('BEGIN');
    const f = await client.query('SELECT *, expires_at <= now() AS gone FROM charger_offers WHERE id = $1 FOR UPDATE', [offerId]);
    if (f.rows.length === 0) { await rollback(client); return { status: 404, body: { error: 'Offer not found' } }; }
    const o = f.rows[0];
    if (o.user_id !== userId) { await rollback(client); return { status: 403, body: { error: 'This offer is not yours' } }; }
    if (o.status !== 'pending') { await rollback(client); return { status: 409, body: { error: `Offer is already ${o.status}` } }; }

    const ch = (await client.query('SELECT id, status, station_id FROM chargers WHERE id = $1 FOR UPDATE', [o.charger_id])).rows[0];
    const fail = async (msg) => { await closeOffer(client, o, 'expired'); await client.query('COMMIT'); reschedule = ch.station_id; return { status: 409, body: { error: msg } }; };

    if (o.gone) result = await fail('This offer has expired');
    else if (ch.status !== 'available') result = await fail('The charger is no longer free');
    else {
      let booking;
      if (o.source === 'queue') {
        const mins = Math.min(SLOT_MIN, await gapMinutes(client, o.charger_id));
        if (mins < 15) result = await fail('Not enough free time left on this charger');
        else {
          booking = (await client.query(
            `INSERT INTO bookings (user_id, vehicle_id, charger_id, status, start_time, end_time)
             VALUES ($1, $2, $3, 'confirmed', now(), now() + make_interval(mins => $4)) RETURNING *`,
            [userId, o.vehicle_id, o.charger_id, mins])).rows[0];
          const q = await client.query("UPDATE queue SET status = 'assigned', booking_id = $1, assigned_at = now() WHERE id = $2 RETURNING *", [booking.id, o.queue_id]);
          events.push(['booking:created', booking], ['queue:updated', { station_id: ch.station_id, action: 'assigned', entry: q.rows[0] }]);
          // Money: accepting means paying the deposit. Not enough balance -> nothing is saved and the offer stays open for a top-up.
          const hold = await holdDeposit(client, booking);
          if (hold.insufficient) {
            await rollback(client); events.length = 0;
            result = { status: 402, body: { error: `You need Rs ${hold.needed} in your wallet to accept (balance Rs ${hold.balance}). Top up and try again before the offer ends.`, needed: hold.needed, balance: hold.balance } };
          }
        }
      } else {
        const bf = await client.query("SELECT * FROM bookings WHERE id = $1 AND status = 'confirmed' FOR UPDATE", [o.booking_id]);
        if (bf.rows.length === 0) result = await fail('Your booking has changed, so this offer is cancelled');
        else {
          const b = bf.rows[0];
          const orig = b.end_time ? Math.floor((new Date(b.end_time) - new Date(b.start_time)) / 60000) : SLOT_MIN;
          const mins = Math.min(orig, await gapMinutes(client, o.charger_id, b.id));
          if (mins < 15) result = await fail('Not enough free time left on this charger');
          else {
            booking = (await client.query(
              `UPDATE bookings SET charger_id = $1, start_time = now(), end_time = now() + make_interval(mins => $2)
               WHERE id = $3 RETURNING *`, [o.charger_id, mins, b.id])).rows[0];
            events.push(['booking:updated', booking]);
          }
        }
      }
      if (!result) {
        await client.query("UPDATE charger_offers SET status = 'accepted', responded_at = now() WHERE id = $1", [o.id]);
        await client.query("UPDATE chargers SET status = 'occupied', updated_at = now() WHERE id = $1", [o.charger_id]);
        events.push(['charger:updated', { id: o.charger_id, station_id: ch.station_id, status: 'occupied' }]);
        await client.query('COMMIT');
        result = { status: 200, body: booking };
      }
    }
  } catch (err) {
    await rollback(client);
    if (err.code === '23P01') result = { status: 409, body: { error: 'That time is no longer free' } };
    else { console.error(err); result = { status: 500, body: { error: 'Failed to accept offer' } }; }
  } finally {
    client.release();
  }
  events.forEach(([ev, p]) => emitSafe(ev, p));
  if (result.status === 200) emitToUser(userId, 'offer:closed', { id: offerId, reason: 'accepted' });
  if (reschedule) await schedule(reschedule);
  return result;
}

async function declineOffer(userId, offerId) {
  const client = await pool.connect();
  let result, station = null;
  try {
    await client.query('BEGIN');
    const f = await client.query('SELECT * FROM charger_offers WHERE id = $1 FOR UPDATE', [offerId]);
    if (f.rows.length === 0) { await rollback(client); return { status: 404, body: { error: 'Offer not found' } }; }
    const o = f.rows[0];
    if (o.user_id !== userId) { await rollback(client); return { status: 403, body: { error: 'This offer is not yours' } }; }
    if (o.status !== 'pending') { await rollback(client); return { status: 409, body: { error: `Offer is already ${o.status}` } }; }
    await closeOffer(client, o, 'declined');
    station = (await client.query('SELECT station_id FROM chargers WHERE id = $1', [o.charger_id])).rows[0].station_id;
    await client.query('COMMIT');
    result = { status: 200, body: { ok: true } };
  } catch (err) {
    await rollback(client);
    console.error(err);
    result = { status: 500, body: { error: 'Failed to decline offer' } };
  } finally {
    client.release();
  }
  if (result.status === 200) { emitToUser(userId, 'offer:closed', { id: offerId, reason: 'declined' }); await schedule(station); } // next candidate
  return result;
}

// Offers nobody answered in time: close them and move on to the next candidate
async function expireOffers() {
  const stations = new Set();
  const r = await pool.query(
    `UPDATE charger_offers o SET status = 'expired', responded_at = now()
     WHERE o.status = 'pending' AND o.expires_at < now()
     RETURNING o.id, o.user_id, o.queue_id, (SELECT station_id FROM chargers WHERE id = o.charger_id) AS station_id`
  );
  for (const o of r.rows) {
    if (o.queue_id) await pool.query("UPDATE queue SET status = 'waiting' WHERE id = $1 AND status = 'promoted'", [o.queue_id]);
    emitToUser(o.user_id, 'offer:closed', { id: o.id, reason: 'expired' });
    stations.add(o.station_id);
  }
  return stations;
}

// Drivers who accepted a queue offer but never started charging: cancel and free the charger
async function expireNoShows() {
  const stale = await pool.query(
    `SELECT q.id AS queue_id, b.id AS booking_id, c.id AS charger_id, c.station_id
     FROM queue q JOIN bookings b ON b.id = q.booking_id JOIN chargers c ON c.id = b.charger_id
     WHERE q.status = 'assigned' AND b.status = 'confirmed' AND b.power_wait_since IS NULL AND q.assigned_at < now() - make_interval(mins => $1)`,
    [HOLD_MIN]
  );
  const stations = new Set();
  for (const s of stale.rows) {
    const client = await pool.connect();
    const events = [];
    try {
      await client.query('BEGIN');
      const b = await client.query("UPDATE bookings SET status = 'cancelled' WHERE id = $1 AND status = 'confirmed' RETURNING *", [s.booking_id]);
      if (b.rows.length > 0) {
        await client.query("UPDATE queue SET status = 'expired' WHERE id = $1", [s.queue_id]);
        await settleCancellation(client, b.rows[0], true); // no-show: deposit back, minus the late fee
        const ch = await client.query(
          `UPDATE chargers SET status = 'available', updated_at = now()
           WHERE id = $1 AND status = 'occupied'
             AND NOT EXISTS (SELECT 1 FROM bookings WHERE charger_id = $1 AND status = 'active' AND id <> $2)
           RETURNING id, station_id, status`,
          [s.charger_id, s.booking_id]
        );
        events.push(['booking:cancelled', b.rows[0]]);
        if (ch.rows[0]) events.push(['charger:updated', ch.rows[0]]);
        events.push(['queue:updated', { station_id: s.station_id, action: 'expired', entry: { id: s.queue_id } }]);
        stations.add(s.station_id);
      }
      await client.query('COMMIT');
      events.forEach(([ev, p]) => emitSafe(ev, p));
    } catch (err) {
      await rollback(client);
      console.error('No-show expiry failed:', err);
    } finally {
      client.release();
    }
  }
  return stations;
}

// Periodic pass: close stale offers/no-shows, then make sure no free charger sits idle
async function tick() {
  try {
    const stations = new Set([...(await expireOffers()), ...(await expireNoShows())]);
    const idle = await pool.query(
      `SELECT DISTINCT c.station_id FROM chargers c WHERE c.status = 'available' AND (
         EXISTS (SELECT 1 FROM queue q WHERE q.station_id = c.station_id AND q.status = 'waiting')
         OR EXISTS (SELECT 1 FROM bookings b JOIN chargers bc ON bc.id = b.charger_id
                    WHERE bc.station_id = c.station_id AND b.status = 'confirmed' AND b.start_time > now()))`
    );
    idle.rows.forEach((r) => stations.add(r.station_id));
    for (const id of stations) await schedule(id);
    // Sessions waiting for station power: retry (power may have been released since)
    const pw = await pool.query("SELECT DISTINCT c.station_id FROM bookings b JOIN chargers c ON c.id = b.charger_id WHERE b.status = 'confirmed' AND b.power_wait_since IS NOT NULL");
    for (const r of pw.rows) await rebalanceStation(pool, r.station_id);
  } catch (err) {
    console.error('Scheduler tick failed:', err);
  }
}
function startScheduler() { setInterval(tick, TICK_MS); tick(); }

module.exports = { schedule, acceptOffer, declineOffer, pendingOffers, expireOffers, expireNoShows, tick, startScheduler, EFFECTIVE, gapMinutes };
