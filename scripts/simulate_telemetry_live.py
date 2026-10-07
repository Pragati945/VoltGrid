import time
import random
import requests
API_BASE = "http://localhost:4000"
LOGIN_EMAIL = "pragati@voltgrid.io"
LOGIN_PASSWORD = "test1234"
ACTIVE_CHARGER_ID = 6     
ACTIVE_BOOKING_ID = None  
UPDATE_INTERVAL_SECONDS = 3
SOC_INCREMENT_PER_TICK = 0.5
MAX_SOC = 100.0
def login():
    resp = requests.post(f"{API_BASE}/auth/login", json={
        "email": LOGIN_EMAIL,
        "password": LOGIN_PASSWORD,
    })
    resp.raise_for_status()
    return resp.json()["token"]
def post_telemetry(token, charger_id, booking_id, power_kw, soc, temp_c):
    resp = requests.post(
        f"{API_BASE}/telemetry",
        headers={"Authorization": f"Bearer {token}"},
        json={
            "charger_id": charger_id,
            "booking_id": booking_id,
            "power_draw_kw": power_kw,
            "battery_soc": soc,
            "temperature_c": temp_c,
        },
    )
    resp.raise_for_status()
    return resp.json()
def main():
    print("Logging in...")
    token = login()
    print("Logged in. Starting live telemetry simulation...")
    print("Open socket-test.html in a browser to watch events arrive live.")
    print("Press Ctrl+C to stop.\n")
    soc = 20.0
    try:
        while soc < MAX_SOC:
            soc = min(MAX_SOC, soc + SOC_INCREMENT_PER_TICK + random.uniform(-0.1, 0.1))
            power_kw = round(random.uniform(40.0, 55.0), 2)
            temp_c = round(random.uniform(27.0, 33.0), 2)
            post_telemetry(token, ACTIVE_CHARGER_ID, ACTIVE_BOOKING_ID, power_kw, round(soc, 2), temp_c)
            print(f"[telemetry] charger={ACTIVE_CHARGER_ID} soc={soc:.2f}% power={power_kw}kW temp={temp_c}C -> broadcast")
            time.sleep(UPDATE_INTERVAL_SECONDS)
        print("\nBattery reached 100% — simulation complete.")
    except KeyboardInterrupt:
        print("\nSimulation stopped by user.")
    except requests.HTTPError as e:
        print(f"\nAPI error: {e.response.status_code} {e.response.text}")
if __name__ == "__main__":
    main()
