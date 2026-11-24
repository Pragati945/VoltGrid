/**
 * VoltGrid - Concurrency Stress Test
 * Fires N simultaneous POST /bookings at the SAME charger. Expected:
 * exactly 1x 201 and (N-1)x 409. Never two 201s, never a 500.
 *
 * Usage:  node concurrencyTest.js <charger_id> <vehicle_id> [concurrent_requests]
 * Example: node concurrencyTest.js 3 1 10        (charger 3, vehicle 1 from the seed)
 *
 * Logs in as the SEEDED admin (public /auth/register can no longer create admins).
 * Override with TEST_ADMIN_EMAIL / TEST_ADMIN_PASSWORD env vars if needed.
 * Requires Node 18+ (built-in fetch).
 */
const BASE_URL = process.env.VOLTGRID_BASE_URL || 'http://localhost:4000';
const ADMIN_EMAIL = process.env.TEST_ADMIN_EMAIL || 'admin@voltgrid.io';
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD || 'Password123!';

const [, , chargerIdArg, vehicleIdArg, countArg] = process.argv;
if (!chargerIdArg || !vehicleIdArg) {
  console.error('Usage: node concurrencyTest.js <charger_id> <vehicle_id> [concurrent_requests]');
  process.exit(1);
}

const CHARGER_ID = Number(chargerIdArg);
const VEHICLE_ID = Number(vehicleIdArg);
const CONCURRENT_REQUESTS = Number(countArg) || 10;

async function api(path, token, method = 'GET', body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, data };
}

async function login() {
  const r = await api('/auth/login', null, 'POST', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  if (!r.ok) throw new Error(`Admin login failed (${r.status}): ${JSON.stringify(r.data)}`);
  return r.data.token;
}

// Clear any leftover confirmed/active booking on the charger, then mark it available
async function prepareCharger(token) {
  const all = await api('/bookings', token);
  if (!all.ok) throw new Error(`Could not list bookings (${all.status})`);
  const stale = all.data.filter(
    (b) => b.charger_id === CHARGER_ID && ['pending', 'confirmed', 'active'].includes(b.status)
  );
  for (const b of stale) {
    await api(`/bookings/${b.id}/cancel`, token, 'PATCH');
    console.log(`  cancelled leftover booking ${b.id}`);
  }
  const r = await api(`/chargers/${CHARGER_ID}/status`, token, 'PATCH', { status: 'available' });
  if (!r.ok) throw new Error(`Failed to reset charger (${r.status}): ${JSON.stringify(r.data)}`);
}

async function main() {
  console.log('VoltGrid concurrency test');
  console.log(`  base URL: ${BASE_URL} | charger: ${CHARGER_ID} | vehicle: ${VEHICLE_ID} | requests: ${CONCURRENT_REQUESTS}\n`);

  const token = await login();
  await api('/wallet/topup', token, 'POST', { amount: 5000 }); // bookings now need a wallet deposit
  console.log('Preparing charger...');
  await prepareCharger(token);

  console.log(`Firing ${CONCURRENT_REQUESTS} simultaneous booking requests...`);
  const start_time = new Date().toISOString();
  const results = await Promise.allSettled(
    Array.from({ length: CONCURRENT_REQUESTS }, (_, i) =>
      api('/bookings', token, 'POST', { vehicle_id: VEHICLE_ID, charger_id: CHARGER_ID, start_time }).then((r) => ({
        index: i,
        ...r,
      }))
    )
  );

  let success = 0, conflict = 0, other = 0;
  let createdId = null;
  for (const r of results) {
    if (r.status === 'rejected') {
      other++;
      console.log(`  [request errored] ${r.reason}`);
      continue;
    }
    const { index, status, data } = r.value;
    if (status === 201) {
      success++;
      createdId = data.id;
      console.log(`  [${index}] 201 Created  -> booking id ${data.id}`);
    } else if (status === 409) {
      conflict++;
      console.log(`  [${index}] 409 Conflict -> ${data.error}`);
    } else {
      other++;
      console.log(`  [${index}] ${status} UNEXPECTED -> ${JSON.stringify(data)}`);
    }
  }

  console.log(`\n--- Results ---\nSuccesses (201): ${success}\nConflicts (409): ${conflict}\nOther: ${other}\n`);

  // Clean up so the test is re-runnable
  if (createdId) await api(`/bookings/${createdId}/cancel`, token, 'PATCH');

  const passed = success === 1 && conflict === CONCURRENT_REQUESTS - 1 && other === 0;
  console.log(passed
    ? 'PASS - exactly 1 booking succeeded, the rest were safely rejected.'
    : 'FAIL - expected exactly 1 success and the rest as 409 conflicts.');
  process.exit(passed ? 0 : 1);
}

main().catch((err) => {
  console.error('Test crashed:', err);
  process.exit(1);
});
