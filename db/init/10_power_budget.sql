-- VoltGrid migration: station power budget (Banker's-algorithm admission control). Safe to run more than once.
ALTER TABLE stations ADD COLUMN IF NOT EXISTS power_limit_kw NUMERIC(7,2) NOT NULL DEFAULT 100.00;
ALTER TABLE stations DROP CONSTRAINT IF EXISTS power_limit_positive;
ALTER TABLE stations ADD CONSTRAINT power_limit_positive CHECK (power_limit_kw > 0);

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS power_claim_kw       NUMERIC(7,2);                      -- "maximum claim": full rate this session can use
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS power_alloc_kw       NUMERIC(7,2) NOT NULL DEFAULT 0;   -- kW granted right now
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS power_wait_since     TIMESTAMPTZ;                       -- set while waiting for station power
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS energy_delivered_kwh NUMERIC(9,3) NOT NULL DEFAULT 0;   -- metered energy (what the driver is billed for)
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS alloc_updated_at     TIMESTAMPTZ;                       -- when the allocation last changed (for metering)
