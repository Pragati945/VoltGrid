BEGIN;
CREATE EXTENSION IF NOT EXISTS btree_gist;
UPDATE bookings SET end_time = start_time + interval '60 minutes'
WHERE end_time IS NULL AND status IN ('confirmed', 'active');
DROP INDEX IF EXISTS uq_active_booking_per_charger;
ALTER TABLE bookings DROP CONSTRAINT IF EXISTS no_overlapping_bookings;
ALTER TABLE bookings ADD CONSTRAINT no_overlapping_bookings
    EXCLUDE USING gist (charger_id WITH =, tstzrange(start_time, end_time) WITH &&)
    WHERE (status IN ('confirmed', 'active'));
COMMIT;
