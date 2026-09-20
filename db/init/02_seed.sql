-- =========================================================
-- VoltGrid: Baseline seed data
-- =========================================================

-- Users (password hashes are placeholders — replace with bcrypt hashes in Phase 2)
INSERT INTO users (name, email, password_hash, role) VALUES
('Admin User',      'admin@voltgrid.io',    '$2b$10$placeholderhash1', 'admin'),
('Station Op One',  'op1@voltgrid.io',      '$2b$10$placeholderhash2', 'operator'),
('Driver A',        'driverA@voltgrid.io',  '$2b$10$placeholderhash3', 'driver'),
('Driver B',        'driverB@voltgrid.io',  '$2b$10$placeholderhash4', 'driver'),
('Emergency Driver','ambulance@voltgrid.io','$2b$10$placeholderhash5', 'driver');

-- Vehicles
INSERT INTO vehicles (user_id, vehicle_model, battery_capacity_kwh, connector_type, is_emergency) VALUES
(3, 'Tata Nexon EV', 40.5, 'CCS2', false),
(4, 'MG ZS EV',      50.0, 'CCS2', false),
(5, 'Electric Ambulance', 80.0, 'CCS2', true);

-- Stations
INSERT INTO stations (name, operator_id, latitude, longitude, address) VALUES
('VoltGrid Station - Dehradun Central', 2, 30.316496, 78.032188, 'Rajpur Road, Dehradun'),
('VoltGrid Station - Clock Tower',      2, 30.323700, 78.043800, 'Clock Tower, Dehradun');

-- Chargers
INSERT INTO chargers (station_id, connector_type, power_rating_kw, status) VALUES
(1, 'CCS2', 60.0, 'available'),
(1, 'CCS2', 60.0, 'available'),
(1, 'CHAdeMO', 50.0, 'available'),
(2, 'CCS2', 30.0, 'available'),
(2, 'Type2', 22.0, 'available');

-- A sample booking + session (so telemetry has something to attach to)
INSERT INTO bookings (user_id, vehicle_id, charger_id, status, start_time) VALUES
(3, 1, 1, 'active', now());

INSERT INTO charging_sessions (booking_id, actual_start, energy_delivered_kwh, final_soc) VALUES
(1, now(), 0, 20.0);

-- Mark that charger as occupied since it now has an active booking
UPDATE chargers SET status = 'occupied' WHERE id = 1;

-- One initial telemetry reading
INSERT INTO telemetry (charger_id, booking_id, power_draw_kw, battery_soc, temperature_c) VALUES
(1, 1, 45.0, 20.0, 28.5);
