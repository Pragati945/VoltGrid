-- =========================================================
-- VoltGrid: Real-Time EV Charging and Station Management
-- Phase 1: Core Schema (9 tables)
-- =========================================================

-- ---------- ENUM TYPES ----------
CREATE TYPE user_role AS ENUM ('admin', 'driver', 'operator');
CREATE TYPE charger_status AS ENUM ('available', 'occupied', 'faulted', 'offline');
CREATE TYPE booking_status AS ENUM ('pending', 'confirmed', 'active', 'completed', 'cancelled');
CREATE TYPE queue_status AS ENUM ('waiting', 'promoted', 'assigned', 'expired');
CREATE TYPE ledger_type AS ENUM ('deposit', 'final_payment', 'refund', 'penalty');

-- ---------- 1. USERS ----------
CREATE TABLE users (
    id              SERIAL PRIMARY KEY,
    name            VARCHAR(100) NOT NULL,
    email           VARCHAR(150) UNIQUE NOT NULL,
    password_hash   VARCHAR(255) NOT NULL,
    role            user_role NOT NULL DEFAULT 'driver',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- 2. VEHICLES ----------
CREATE TABLE vehicles (
    id                  SERIAL PRIMARY KEY,
    user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    vehicle_model       VARCHAR(100),
    battery_capacity_kwh NUMERIC(6,2) NOT NULL,
    connector_type      VARCHAR(30) NOT NULL,
    is_emergency        BOOLEAN NOT NULL DEFAULT false,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- 3. STATIONS ----------
CREATE TABLE stations (
    id              SERIAL PRIMARY KEY,
    name            VARCHAR(150) NOT NULL,
    operator_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
    latitude        NUMERIC(9,6),
    longitude       NUMERIC(9,6),
    address         TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- 4. CHARGERS ----------
CREATE TABLE chargers (
    id              SERIAL PRIMARY KEY,
    station_id      INTEGER NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
    connector_type  VARCHAR(30) NOT NULL,
    power_rating_kw NUMERIC(6,2) NOT NULL,
    status          charger_status NOT NULL DEFAULT 'available',
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_chargers_station_status ON chargers(station_id, status);

-- ---------- 5. BOOKINGS ----------
CREATE TABLE bookings (
    id              SERIAL PRIMARY KEY,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    vehicle_id      INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
    charger_id      INTEGER NOT NULL REFERENCES chargers(id) ON DELETE CASCADE,
    status          booking_status NOT NULL DEFAULT 'pending',
    start_time      TIMESTAMPTZ NOT NULL,
    end_time        TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Prevents two active/confirmed bookings on the same charger at once
CREATE UNIQUE INDEX uq_active_booking_per_charger
    ON bookings(charger_id)
    WHERE status IN ('confirmed', 'active');
CREATE INDEX idx_bookings_user ON bookings(user_id);

-- ---------- 6. CHARGING SESSIONS ----------
CREATE TABLE charging_sessions (
    id                  SERIAL PRIMARY KEY,
    booking_id          INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    actual_start        TIMESTAMPTZ,
    actual_end          TIMESTAMPTZ,
    energy_delivered_kwh NUMERIC(7,3) DEFAULT 0,
    final_soc           NUMERIC(5,2)
);

-- ---------- 7. QUEUE (priority scheduling) ----------
CREATE TABLE queue (
    id              SERIAL PRIMARY KEY,
    station_id      INTEGER NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
    vehicle_id      INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
    priority_level  SMALLINT NOT NULL DEFAULT 0, -- higher = more urgent (emergency vehicles)
    status          queue_status NOT NULL DEFAULT 'waiting',
    requested_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_queue_station_priority ON queue(station_id, priority_level DESC, requested_at ASC);

-- ---------- 8. TELEMETRY (dynamic, frequently updated) ----------
CREATE TABLE telemetry (
    id              BIGSERIAL PRIMARY KEY,
    charger_id      INTEGER NOT NULL REFERENCES chargers(id) ON DELETE CASCADE,
    booking_id      INTEGER REFERENCES bookings(id) ON DELETE SET NULL,
    power_draw_kw   NUMERIC(6,2),
    battery_soc     NUMERIC(5,2),
    temperature_c   NUMERIC(5,2),
    recorded_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_telemetry_charger_time ON telemetry(charger_id, recorded_at DESC);

-- ---------- 9. LEDGER (payments) ----------
CREATE TABLE ledger (
    id              SERIAL PRIMARY KEY,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    booking_id      INTEGER REFERENCES bookings(id) ON DELETE SET NULL,
    amount          NUMERIC(10,2) NOT NULL,
    type            ledger_type NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_ledger_user ON ledger(user_id);
