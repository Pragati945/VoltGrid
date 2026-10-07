const BASE_URL = process.env.VOLTGRID_BASE_URL || 'http://localhost:4000';
const [, , chargerIdArg, vehicleIdArg, countArg] = process.argv;
if (!chargerIdArg || !vehicleIdArg) {
  console.error('Usage: node concurrencyTest.js <charger_id> <vehicle_id> [concurrent_requests]');
  process.exit(1);
}
const CHARGER_ID = Number(chargerIdArg);
const VEHICLE_ID = Number(vehicleIdArg);
const CONCURRENT_REQUESTS = Number(countArg) || 10;
async function registerThrowawayAdmin() {
  const email = `stress-test-${Date.now()}@voltgrid.io`;
  const res = await fetch(`${BASE_URL}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Concurrency Test Admin',
      email,
      password: 'test-password-123',
      role: 'admin',
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to register throwaway admin (${res.status}): ${body}`);
  }
  const { token } = await res.json();
  return token;
}
async function resetCharger(token) {
  const res = await fetch(`${BASE_URL}/chargers/${CHARGER_ID}/status`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ status: 'available' }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to reset charger ${CHARGER_ID} to available (${res.status}): ${body}`);
  }
}
async function fireBookingAttempt(token, index) {
  const res = await fetch(`${BASE_URL}/bookings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      vehicle_id: VEHICLE_ID,
      charger_id: CHARGER_ID,
      start_time: new Date().toISOString(),
    }),
  });
  const body = await res.json().catch(() => ({}));
  return { index, status: res.status, body };
}
async function main() {
  console.log(`VoltGrid concurrency test`);
  console.log(`  base URL:   ${BASE_URL}`);
  console.log(`  charger_id: ${CHARGER_ID}`);
  console.log(`  vehicle_id: ${VEHICLE_ID}`);
  console.log(`  requests:   ${CONCURRENT_REQUESTS}`);
  console.log('');
  console.log('Registering throwaway admin user...');
  const token = await registerThrowawayAdmin();
  console.log(`Resetting charger ${CHARGER_ID} to 'available'...`);
  await resetCharger(token);
  console.log(`Firing ${CONCURRENT_REQUESTS} simultaneous booking requests...`);
  const attempts = Array.from({ length: CONCURRENT_REQUESTS }, (_, i) =>
    fireBookingAttempt(token, i)
  );
  const results = await Promise.allSettled(attempts);
  let successCount = 0;
  let conflictCount = 0;
  let otherCount = 0;
  for (const result of results) {
    if (result.status === 'rejected') {
      otherCount++;
      console.log(`  [request errored] ${result.reason}`);
      continue;
    }
    const { index, status, body } = result.value;
    if (status === 201) {
      successCount++;
      console.log(`  [${index}] 201 Created  -> booking id ${body.id}`);
    } else if (status === 409) {
      conflictCount++;
      console.log(`  [${index}] 409 Conflict -> ${body.error}`);
    } else {
      otherCount++;
      console.log(`  [${index}] ${status} UNEXPECTED -> ${JSON.stringify(body)}`);
    }
  }
  console.log('');
  console.log('--- Results ---');
  console.log(`Successes (201):     ${successCount}`);
  console.log(`Conflicts (409):     ${conflictCount}`);
  console.log(`Other/unexpected:    ${otherCount}`);
  console.log('');
  const passed = successCount === 1 && conflictCount === CONCURRENT_REQUESTS - 1 && otherCount === 0;
  if (passed) {
    console.log('✅ PASS — exactly 1 booking succeeded, the rest were safely rejected.');
  } else {
    console.log('❌ FAIL — expected exactly 1 success and the rest as 409 conflicts.');
    console.log('   This suggests the row lock (SELECT ... FOR UPDATE) is not holding under load.');
  }
  process.exit(passed ? 0 : 1);
}
main().catch((err) => {
  console.error('Test crashed:', err);
  process.exit(1);
});
