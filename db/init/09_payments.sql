-- VoltGrid migration: wallet + payments. Safe to run more than once.
-- (Run these statements one after another; ALTER TYPE ... ADD VALUE must not be wrapped in BEGIN/COMMIT on older Postgres.)
ALTER TYPE ledger_type ADD VALUE IF NOT EXISTS 'topup';

ALTER TABLE users    ADD COLUMN IF NOT EXISTS wallet_balance NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE users    DROP CONSTRAINT IF EXISTS wallet_not_negative;
ALTER TABLE users    ADD CONSTRAINT wallet_not_negative CHECK (wallet_balance >= 0);

ALTER TABLE stations ADD COLUMN IF NOT EXISTS price_per_kwh NUMERIC(6,2) NOT NULL DEFAULT 18.00;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS charging_started_at TIMESTAMPTZ;

-- Only checks NEW rows, so old test data can't block the migration
ALTER TABLE ledger   DROP CONSTRAINT IF EXISTS ledger_amount_positive;
ALTER TABLE ledger   ADD CONSTRAINT ledger_amount_positive CHECK (amount > 0) NOT VALID;
