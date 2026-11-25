/**
 * VoltGrid payments (simulated wallet, no real gateway).
 *
 * Ledger direction by type:   credits (+wallet): topup, refund      debits (-wallet): deposit, final_payment, penalty
 *
 * Booking   : DEPOSIT = hold of the estimated cost of the booked slot (refused if the wallet can't cover it).
 * Finishing : the hold is released (refund) and the ACTUAL cost is charged (final_payment). Never more than the hold.
 * Cancelling: the deposit is refunded. A late cancel / no-show also pays a PENALTY (a % of the deposit).
 * Every step runs inside the caller's database transaction, so a booking and its money always succeed or fail together.
 */
const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : d);
const FREE_CANCEL_MIN = num(process.env.FREE_CANCEL_MINUTES, 30);       // free cancel until this long before the slot
const GRACE_MIN = 5;                                                    // ...or within 5 minutes of making the booking
const PENALTY_PCT = num(process.env.LATE_CANCEL_PENALTY_PERCENT, 20);
const DEFAULT_SLOT_MIN = 60;
const round2 = (n) => Math.round(n * 100) / 100;

async function pricing(db, chargerId, vehicleId) {
  const r = await db.query(
    `SELECT c.power_rating_kw, s.price_per_kwh, m.max_charge_rate_kw, m.battery_capacity_kwh
     FROM chargers c JOIN stations s ON s.id = c.station_id, vehicles v JOIN vehicle_models m ON m.id = v.model_id
     WHERE c.id = $1 AND v.id = $2`,
    [chargerId, vehicleId]
  );
  return r.rows[0];
}

// energy = min(charger kW, car's max kW) x hours, never more than the battery holds; cost = energy x station price
function estimate(p, minutes) {
  const chargerKw = Number(p.power_rating_kw);
  const carKw = p.max_charge_rate_kw ? Number(p.max_charge_rate_kw) : chargerKw;
  const kw = Math.min(chargerKw, carKw);
  const cap = p.battery_capacity_kwh ? Number(p.battery_capacity_kwh) : Infinity;
  const energy = Math.min((kw * Math.max(0, minutes)) / 60, cap);
  const price = Number(p.price_per_kwh);
  return { effective_kw: kw, energy_kwh: Math.round(energy * 1000) / 1000, price_per_kwh: price, amount: round2(energy * price) };
}

async function balanceOf(db, userId) {
  const r = await db.query('SELECT wallet_balance FROM users WHERE id = $1', [userId]);
  return r.rows.length ? Number(r.rows[0].wallet_balance) : 0;
}

// Atomic: the UPDATE only succeeds if the balance is enough, so two requests can never spend the same money
async function debit(db, userId, bookingId, amount, type) {
  const r = await db.query(
    'UPDATE users SET wallet_balance = wallet_balance - $2 WHERE id = $1 AND wallet_balance >= $2 RETURNING wallet_balance',
    [userId, amount]
  );
  if (r.rows.length === 0) return null;
  await db.query('INSERT INTO ledger (user_id, booking_id, amount, type) VALUES ($1, $2, $3, $4)', [userId, bookingId, amount, type]);
  return Number(r.rows[0].wallet_balance);
}
async function credit(db, userId, bookingId, amount, type) {
  const r = await db.query('UPDATE users SET wallet_balance = wallet_balance + $2 WHERE id = $1 RETURNING wallet_balance', [userId, amount]);
  await db.query('INSERT INTO ledger (user_id, booking_id, amount, type) VALUES ($1, $2, $3, $4)', [userId, bookingId, amount, type]);
  return Number(r.rows[0].wallet_balance);
}

async function holdDeposit(db, booking) {
  const p = await pricing(db, booking.charger_id, booking.vehicle_id);
  const mins = Math.round((new Date(booking.end_time) - new Date(booking.start_time)) / 60000) || DEFAULT_SLOT_MIN;
  const est = estimate(p, mins);
  if (est.amount <= 0) return { amount: 0, balance: await balanceOf(db, booking.user_id), ...est };
  const bal = await debit(db, booking.user_id, booking.id, est.amount, 'deposit');
  if (bal === null) return { insufficient: true, needed: est.amount, balance: await balanceOf(db, booking.user_id) };
  return { amount: est.amount, balance: bal, ...est };
}

// money currently held for a booking = deposits - refunds
async function netHeld(db, bookingId) {
  const r = await db.query(
    `SELECT COALESCE(SUM(CASE WHEN type = 'deposit' THEN amount WHEN type = 'refund' THEN -amount ELSE 0 END), 0) AS held
     FROM ledger WHERE booking_id = $1`, [bookingId]);
  return Number(r.rows[0].held);
}

// Power-managed sessions are billed on the energy actually metered, so a throttled session pays less
function meteredEstimate(p, b) {
  const cap = p.battery_capacity_kwh ? Number(p.battery_capacity_kwh) : Infinity;
  const energy = Math.min(Number(b.energy_delivered_kwh || 0), cap);
  const price = Number(p.price_per_kwh);
  return { effective_kw: null, energy_kwh: Math.round(energy * 1000) / 1000, price_per_kwh: price, amount: round2(energy * price) };
}

// Charging finished: release the hold, charge for what was actually delivered
async function settleCompletion(db, b) {
  const held = await netHeld(db, b.id);
  const m = await db.query(
    `SELECT COALESCE(GREATEST(0, EXTRACT(EPOCH FROM (LEAST(now(), COALESCE($1::timestamptz, now())) - $2::timestamptz)) / 60), 0) AS mins`,
    [b.end_time, b.charging_started_at]);
  const p = await pricing(db, b.charger_id, b.vehicle_id);
  const est = b.power_claim_kw !== null && b.power_claim_kw !== undefined
    ? meteredEstimate(p, b)
    : estimate(p, Number(m.rows[0].mins));
  const charged = round2(Math.min(est.amount, held));
  if (held > 0) await credit(db, b.user_id, b.id, held, 'refund');
  if (charged > 0) {
    const ok = await debit(db, b.user_id, b.id, charged, 'final_payment');
    if (ok === null) throw new Error('Could not charge final payment');
  }
  return { held, charged, returned: round2(held - charged), penalty: 0, minutes_charged: Math.round(Number(m.rows[0].mins)), energy_kwh: est.energy_kwh };
}

// Cancelled before charging: deposit back, plus a fee if it was late (or a no-show)
async function settleCancellation(db, b, late) {
  const held = await netHeld(db, b.id);
  if (held > 0) await credit(db, b.user_id, b.id, held, 'refund');
  const penalty = late && held > 0 ? round2((held * PENALTY_PCT) / 100) : 0;
  if (penalty > 0) await debit(db, b.user_id, b.id, penalty, 'penalty');
  return { held, charged: 0, returned: held, penalty };
}

function isLateCancel(b) {
  const untilStart = (new Date(b.start_time) - Date.now()) / 60000;
  const sinceBooked = (Date.now() - new Date(b.created_at)) / 60000;
  return untilStart < FREE_CANCEL_MIN && sinceBooked > GRACE_MIN;
}

module.exports = { pricing, estimate, balanceOf, debit, credit, holdDeposit, netHeld, settleCompletion, settleCancellation, isLateCancel, FREE_CANCEL_MIN, PENALTY_PCT };
