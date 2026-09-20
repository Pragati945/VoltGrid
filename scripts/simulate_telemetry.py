"""
VoltGrid Telemetry Simulator
-----------------------------
Simulates the "Telemetry Engine" described in the VoltGrid proposal.
Since there's no real charging hardware, this script mimics an EV
charging session by writing new rows into the `telemetry` table every
few seconds, with battery_soc increasing and power_draw fluctuating
slightly, exactly like a real charger would report.

This proves the database layer supports dynamic, changing data
BEFORE the REST API / WebSocket layer (Phase 2) exists.

Usage:
    pip install psycopg2-binary
    python simulate_telemetry.py
"""

import time
import random
import psycopg2

DB_CONFIG = {
    "host": "localhost",
    "port": 5432,
    "dbname": "voltgrid",
    "user": "voltgrid_admin",
    "password": "voltgrid_pass",
}

# charger_id -> booking_id that we seeded in 02_seed.sql
ACTIVE_CHARGER_ID = 1
ACTIVE_BOOKING_ID = 1

UPDATE_INTERVAL_SECONDS = 3
SOC_INCREMENT_PER_TICK = 0.5   # % battery per tick
MAX_SOC = 100.0


def get_connection():
    return psycopg2.connect(**DB_CONFIG)


def get_latest_soc(conn, charger_id):
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT battery_soc FROM telemetry
            WHERE charger_id = %s
            ORDER BY recorded_at DESC
            LIMIT 1
            """,
            (charger_id,),
        )
        row = cur.fetchone()
        return float(row[0]) if row else 20.0


def insert_telemetry(conn, charger_id, booking_id, power_kw, soc, temp_c):
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO telemetry (charger_id, booking_id, power_draw_kw, battery_soc, temperature_c)
            VALUES (%s, %s, %s, %s, %s)
            """,
            (charger_id, booking_id, power_kw, soc, temp_c),
        )
    conn.commit()


def main():
    conn = get_connection()
    print("Connected to VoltGrid database. Starting telemetry simulation...")
    print("Press Ctrl+C to stop.\n")

    soc = get_latest_soc(conn, ACTIVE_CHARGER_ID)

    try:
        while soc < MAX_SOC:
            soc = min(MAX_SOC, soc + SOC_INCREMENT_PER_TICK + random.uniform(-0.1, 0.1))
            power_kw = round(random.uniform(40.0, 55.0), 2)   # fluctuating draw
            temp_c = round(random.uniform(27.0, 33.0), 2)

            insert_telemetry(conn, ACTIVE_CHARGER_ID, ACTIVE_BOOKING_ID, power_kw, round(soc, 2), temp_c)

            print(f"[telemetry] charger={ACTIVE_CHARGER_ID} soc={soc:.2f}% power={power_kw}kW temp={temp_c}C")
            time.sleep(UPDATE_INTERVAL_SECONDS)

        print("\nBattery reached 100% — simulation complete.")

    except KeyboardInterrupt:
        print("\nSimulation stopped by user.")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
