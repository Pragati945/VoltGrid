# VoltGrid — Phase 2: JWT Auth + REST CRUD API

This connects to the same Postgres database from Phase 1 — make sure your
Docker containers (`voltgrid_postgres`, `voltgrid_adminer`) are already
running before starting this.

## 1. Install dependencies
From inside the `api` folder:
```bash
cd api
npm install
```

## 2. Configure environment variables
```bash
copy .env.example .env
```
(On Mac/Linux use `cp` instead of `copy`.)

Open `.env` and replace `JWT_SECRET` with a real random string. You can
generate one with:
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```
The database values (`PGHOST`, `PGUSER`, etc.) already match your Phase 1
`docker-compose.yml` — leave those as-is unless you changed them.

## 3. Start the API
```bash
npm start
```
You should see: `VoltGrid API listening on http://localhost:4000`

Test it's alive:
```bash
curl http://localhost:4000/health
```

## Important note on the Phase 1 seed data
The users inserted by `02_seed.sql` have **fake placeholder password
hashes** (`$2b$10$placeholderhash1`, etc.) — they are not real bcrypt
hashes, so you **cannot log in as those seeded users**. Instead, register
fresh users through the API:

```bash
curl -X POST http://localhost:4000/auth/register ^
  -H "Content-Type: application/json" ^
  -d "{\"name\":\"Pragati\",\"email\":\"pragati@voltgrid.io\",\"password\":\"test1234\",\"role\":\"driver\"}"
```
(Windows Command Prompt uses `^` for line continuation and needs escaped
quotes like above. If you're using PowerShell or a tool like Postman/Insomnia,
plain JSON works normally.)

This returns a `token` — copy it, you'll need it for every other request.

## 4. Testing the endpoints
Recommended: use **Postman** or **Insomnia** (much easier than curl for
adding the Authorization header repeatedly). For every protected route, add:
```
Authorization: Bearer <the token from register/login>
```

### Typical flow to test
1. `POST /auth/register` → get a token (as a `driver`)
2. `POST /vehicles` → register a vehicle for yourself
3. `GET /stations` → see the two seeded stations
4. `GET /chargers?station_id=1` → see its chargers
5. `POST /bookings` with `{ vehicle_id, charger_id, start_time }` → books it,
   locks the charger row, sets charger status to `occupied`
6. Try the same `POST /bookings` again with a **second** browser tab/user
   for the same `charger_id` → you should get `409 Charger is not available`
   — this proves the row-locking works
7. `PATCH /bookings/:id/complete` → frees the charger back to `available`

### Admin-only routes
Register a second user with `"role": "admin"` to test:
- `GET /users`
- `DELETE /users/:id`
- `DELETE /stations/:id`
- `POST /ledger`

## 5. Proving the row-level locking (no double-booking)
This is the core ACID requirement from your proposal. To demonstrate it
under real concurrent load rather than just sequential testing, fire two
booking requests for the *same* charger at the same instant:

```bash
# In two separate terminals, run at the same time:
curl -X POST http://localhost:4000/bookings -H "Authorization: Bearer TOKEN_A" -H "Content-Type: application/json" -d "{\"vehicle_id\":1,\"charger_id\":2,\"start_time\":\"2026-09-20T10:00:00Z\"}"
curl -X POST http://localhost:4000/bookings -H "Authorization: Bearer TOKEN_B" -H "Content-Type: application/json" -d "{\"vehicle_id\":2,\"charger_id\":2,\"start_time\":\"2026-09-20T10:00:00Z\"}"
```
Exactly one should succeed (`201`), the other should get `409`. That's
your zero-double-booking proof for the report.

## What's next (Phase 3 candidates)
- Replace the standalone `simulate_telemetry.py` with a background worker
  inside this API that calls `POST /telemetry` on an interval.
- Add a Socket.IO server here that broadcasts new telemetry/queue/booking
  events to connected clients in real time.
- Automatically promote the next `queue` entry to a `booking` when a
  charger frees up.
