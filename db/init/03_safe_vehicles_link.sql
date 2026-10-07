BEGIN;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS model_id INTEGER REFERENCES vehicle_models(id);
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = current_schema() AND table_name = 'vehicles' AND column_name = 'vehicle_model') THEN
    UPDATE vehicles v SET model_id = m.id
    FROM vehicle_models m
    WHERE v.model_id IS NULL
      AND (m.model_name = v.vehicle_model OR m.brand || ' ' || m.model_name = v.vehicle_model);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = current_schema() AND table_name = 'vehicles' AND column_name = 'battery_capacity_kwh') THEN
    ALTER TABLE vehicles ALTER COLUMN battery_capacity_kwh DROP NOT NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = current_schema() AND table_name = 'vehicles' AND column_name = 'connector_type') THEN
    ALTER TABLE vehicles ALTER COLUMN connector_type DROP NOT NULL;
  END IF;
END $$;
COMMIT;
SELECT id, user_id FROM vehicles WHERE model_id IS NULL;
