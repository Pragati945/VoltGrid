-- VoltGrid migration: lets the queue scheduler record which booking it created. Safe to run more than once.
ALTER TABLE queue ADD COLUMN IF NOT EXISTS booking_id  INTEGER REFERENCES bookings(id) ON DELETE SET NULL;
ALTER TABLE queue ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ;
