-- VoltGrid migration: "charger is free now - want it?" offers. Safe to run more than once.
CREATE TABLE IF NOT EXISTS charger_offers (
    id           SERIAL PRIMARY KEY,
    charger_id   INTEGER NOT NULL REFERENCES chargers(id) ON DELETE CASCADE,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    vehicle_id   INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
    source       VARCHAR(10) NOT NULL CHECK (source IN ('queue', 'booking')),
    queue_id     INTEGER REFERENCES queue(id) ON DELETE SET NULL,
    booking_id   INTEGER REFERENCES bookings(id) ON DELETE SET NULL,
    status       VARCHAR(10) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined','expired')),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at   TIMESTAMPTZ NOT NULL,
    responded_at TIMESTAMPTZ
);
-- A charger can only have ONE open offer at a time
CREATE UNIQUE INDEX IF NOT EXISTS uq_pending_offer_per_charger ON charger_offers(charger_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_offers_user ON charger_offers(user_id, status);
