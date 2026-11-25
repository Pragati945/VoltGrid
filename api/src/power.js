/**
 * VoltGrid station power manager: resource allocation with Banker's-algorithm safety checking.
 *
 *   resource   = the station's grid limit (kW), stations.power_limit_kw
 *   process    = a charging session (an active booking)
 *   Max        = the session's claim: min(charger rating, vehicle's max charge rate)
 *   Allocation = the kW it holds right now            Available = limit - sum(Allocation)
 *
 * Sessions ramp up in small steps. A step is granted only if the NEW state is SAFE, i.e. there is an order in which
 * every session can reach its Max and finish, releasing its power for the next one (Banker's safety algorithm).
 * A state with nobody able to finish (everyone stuck below their claim, nothing left) is the power deadlock we avoid.
 * Sessions that cannot get at least MIN_START_KW wait; when power is released they are started automatically.
 * Energy is metered (kW x time) so a throttled session is billed only for what it received.
 */
const { emitSafe, emitToUser } = require('./socket');

const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
const STEP_KW = num(process.env.POWER_STEP_KW, 5);          // size of one ramp-up request
const MIN_START_KW = num(process.env.POWER_MIN_START_KW, 10); // least power worth starting a session with
const U = 100;                                               // integer units (hundredths of a kW) keep the arithmetic exact
const toU = (kw) => Math.round(Number(kw) * U);
const toKw = (u) => u / U;

// ---- Banker's safety algorithm (single resource). sessions: [{id, max, alloc}] in any consistent unit ----
function isSafe(capacity, sessions) {
  let work = capacity - sessions.reduce((a, s) => a + s.alloc, 0);
  if (work < 0) return { safe: false, sequence: [], available: work };            // over-committed
  const done = new Set();
  const sequence = [];
  let progress = true;
  while (progress) {
    progress = false;
    for (const s of sessions) {
      if (!done.has(s.id) && s.max - s.alloc <= work) {   // Need <= Work: this session can run to completion
        work += s.alloc;                                  // ...and then releases everything it holds
        done.add(s.id); sequence.push(s.id); progress = true;
      }
    }
  }
  return { safe: done.size === sessions.length, sequence, available: capacity - sessions.reduce((a, s) => a + s.alloc, 0) };
}

// Ramp every session up, in priority order, one step at a time, until nothing more can be granted.
// safety=false is the "naive" policy (only stay under the limit) kept for comparison.
function ramp(capacity, sessions, { step, minStart, safety = true }) {
  // Banker's rule: no process may claim more than the system total (otherwise it could never finish)
  const S = sessions.map((s) => ({ ...s, max: Math.min(s.max, capacity) }));
  let progressed = true;
  for (let guard = 0; progressed && guard < 100000; guard++) {
    progressed = false;
    let avail = capacity - S.reduce((a, s) => a + s.alloc, 0);
    for (const s of S) {
      if (s.alloc >= s.max) continue;
      const inc = s.alloc === 0 ? Math.min(s.max, minStart) : Math.min(s.max - s.alloc, step);
      if (inc > avail) continue;
      s.alloc += inc;
      if (!safety || isSafe(capacity, S).safe) { avail -= inc; progressed = true; } else s.alloc -= inc;
    }
  }
  return S;
}

// ---- database side ----
const SESSIONS_SQL = `
  SELECT b.id, b.user_id, b.charger_id, b.status, b.power_claim_kw, b.power_alloc_kw, b.power_wait_since,
         c.power_rating_kw, c.status AS charger_status, v.is_emergency, m.max_charge_rate_kw
  FROM bookings b JOIN chargers c ON c.id = b.charger_id
  JOIN vehicles v ON v.id = b.vehicle_id JOIN vehicle_models m ON m.id = v.model_id
  WHERE c.station_id = $1 AND (b.status = 'active' OR (b.status = 'confirmed' AND b.power_wait_since IS NOT NULL))`;

function claimKw(r, limitKw) {
  const natural = Math.min(Number(r.power_rating_kw), r.max_charge_rate_kw ? Number(r.max_charge_rate_kw) : Infinity);
  const c = r.power_claim_kw !== null && r.power_claim_kw !== undefined ? Number(r.power_claim_kw) : natural;
  return Math.min(c, limitKw);
}
function toSessions(rows, limitKw) {
  return rows
    .map((r) => ({ id: r.id, row: r, emergency: !!r.is_emergency, active: r.status === 'active', max: toU(claimKw(r, limitKw)), alloc: toU(r.power_alloc_kw || 0) }))
    .sort((a, b) => (b.emergency - a.emergency) || (b.active - a.active) || (a.id - b.id)); // emergency first, running before waiting, then oldest
}

// One decision round for a station. Call it inside a transaction; call out.emit() AFTER the commit.
async function rebalance(db, stationId, { skipNotify = 0 } = {}) {
  await db.query('SELECT pg_advisory_xact_lock(7002, $1)', [stationId]);
  const st = await db.query('SELECT id, name, power_limit_kw FROM stations WHERE id = $1', [stationId]);
  const none = { events: [], notify: [], emit() {} };
  if (st.rows.length === 0) return none;
  const limitKw = Number(st.rows[0].power_limit_kw);
  const rows = (await db.query(`${SESSIONS_SQL} ORDER BY b.id FOR UPDATE OF b`, [stationId])).rows;
  if (rows.length === 0) return none;

  const before = toSessions(rows, limitKw);
  const after = ramp(toU(limitKw), before, { step: toU(STEP_KW), minStart: toU(MIN_START_KW) });
  const events = [], notify = [];
  let changed = false;

  for (let i = 0; i < after.length; i++) {
    const s = after[i], r = s.row, newKw = toKw(s.alloc), claim = toKw(s.max), oldU = toU(r.power_alloc_kw || 0);
    if (s.active) {
      if (s.alloc !== oldU || r.power_claim_kw === null) {
        // meter the energy delivered at the OLD allocation before switching to the new one
        await db.query(
          `UPDATE bookings SET energy_delivered_kwh = energy_delivered_kwh +
             CASE WHEN alloc_updated_at IS NULL THEN 0 ELSE power_alloc_kw * GREATEST(0, EXTRACT(EPOCH FROM (now() - alloc_updated_at))) / 3600 END,
             power_alloc_kw = $2, power_claim_kw = $3, alloc_updated_at = now() WHERE id = $1`,
          [s.id, newKw, claim]);
        if (s.alloc !== oldU) changed = true;
      }
    } else if (s.alloc > 0) {                                   // a waiting session finally gets power: start it
      await db.query(
        `UPDATE bookings SET status = 'active', charging_started_at = now(), power_claim_kw = $2, power_alloc_kw = $3,
           power_wait_since = NULL, alloc_updated_at = now() WHERE id = $1`, [s.id, claim, newKw]);
      const ch = await db.query("UPDATE chargers SET status = 'occupied', updated_at = now() WHERE id = $1 AND status = 'available' RETURNING id, station_id, status", [r.charger_id]);
      events.push(['booking:started', { id: s.id, charger_id: r.charger_id, power_alloc_kw: newKw, power_claim_kw: claim }]);
      if (ch.rows[0]) events.push(['charger:updated', ch.rows[0]]);
      if (s.id !== skipNotify) notify.push([r.user_id, 'power:granted', { booking_id: s.id, charger_id: r.charger_id, station_name: st.rows[0].name, allocated_kw: newKw, claim_kw: claim }]);
      changed = true;
    } else if (r.power_claim_kw === null) {
      await db.query('UPDATE bookings SET power_claim_kw = $2 WHERE id = $1', [s.id, claim]);
    }
  }
  if (changed) events.push(['power:updated', { station_id: stationId }]);
  return { events, notify, emit() { events.forEach(([e, p]) => emitSafe(e, p)); notify.forEach(([u, e, p]) => emitToUser(u, e, p)); } };
}

async function rebalanceForCharger(db, chargerId, opts) {
  const r = await db.query('SELECT station_id FROM chargers WHERE id = $1', [chargerId]);
  return r.rows.length ? rebalance(db, r.rows[0].station_id, opts) : { events: [], notify: [], emit() {} };
}

// Stand-alone run (own transaction), used by the periodic check and by limit changes
async function rebalanceStation(pool, stationId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await rebalance(client, stationId);
    await client.query('COMMIT');
    out.emit();
    return out;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (e) { /* ignore */ }
    console.error('Power rebalance failed for station', stationId, err);
    return { events: [], notify: [], emit() {} };
  } finally {
    client.release();
  }
}

// Take the station's power lock BEFORE any booking row lock, so two requests can never wait on each other
async function lockStationForBooking(db, bookingId) {
  const r = await db.query('SELECT c.station_id FROM bookings b JOIN chargers c ON c.id = b.charger_id WHERE b.id = $1', [bookingId]);
  if (r.rows.length) await db.query('SELECT pg_advisory_xact_lock(7002, $1)', [r.rows[0].station_id]);
}

// "Please start my charging": records the session's claim and puts it in the waiting state; rebalance() decides
async function requestPower(db, booking) {
  const r = await db.query(
    `SELECT LEAST(c.power_rating_kw, COALESCE(m.max_charge_rate_kw, c.power_rating_kw)) AS claim
     FROM chargers c, vehicles v JOIN vehicle_models m ON m.id = v.model_id WHERE c.id = $1 AND v.id = $2`,
    [booking.charger_id, booking.vehicle_id]);
  await db.query('UPDATE bookings SET power_claim_kw = $2, power_wait_since = COALESCE(power_wait_since, now()) WHERE id = $1', [booking.id, r.rows[0].claim]);
}

// A session ends (finished or cancelled): stop the meter, add the last slice of energy, release its power
async function finalizeSession(db, bookingId) {
  const r = await db.query(
    `UPDATE bookings SET energy_delivered_kwh = energy_delivered_kwh +
       CASE WHEN alloc_updated_at IS NULL THEN 0 ELSE power_alloc_kw * GREATEST(0, EXTRACT(EPOCH FROM (now() - alloc_updated_at))) / 3600 END,
       power_alloc_kw = 0, power_wait_since = NULL, alloc_updated_at = NULL
     WHERE id = $1 RETURNING *`, [bookingId]);
  return r.rows[0];
}

// Read-only picture of a station for the API / dashboard
async function snapshot(db, stationId) {
  const st = await db.query('SELECT id, name, power_limit_kw FROM stations WHERE id = $1', [stationId]);
  if (st.rows.length === 0) return null;
  const limitKw = Number(st.rows[0].power_limit_kw);
  const rows = (await db.query(`${SESSIONS_SQL} ORDER BY b.id`, [stationId])).rows;
  const all = toSessions(rows, limitKw);
  const running = all.filter((s) => s.active), waiting = all.filter((s) => !s.active);
  const allocated = toKw(running.reduce((a, s) => a + s.alloc, 0));
  const safety = isSafe(toU(limitKw), running);
  return {
    station_id: st.rows[0].id, name: st.rows[0].name, limit_kw: limitKw, allocated_kw: allocated,
    available_kw: Math.round((limitKw - allocated) * 100) / 100,
    safe: safety.safe, safe_sequence: safety.sequence,
    sessions: running.map((s) => ({ booking_id: s.id, charger_id: s.row.charger_id, claim_kw: toKw(s.max), alloc_kw: toKw(s.alloc), throttled: s.alloc < s.max, emergency: s.emergency })),
    waiting: waiting.map((s) => ({ booking_id: s.id, charger_id: s.row.charger_id, claim_kw: toKw(s.max), waiting_since: s.row.power_wait_since, emergency: s.emergency })),
  };
}

module.exports = { isSafe, ramp, rebalance, rebalanceForCharger, rebalanceStation, lockStationForBooking, requestPower, finalizeSession, snapshot, STEP_KW, MIN_START_KW, toU, toKw };
