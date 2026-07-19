import sys
import time
import requests
from locationsharinglib import Service
from locationsharinglib.locationsharinglibexceptions import InvalidCookies

# --- Configuration ---
COOKIES_FILE  = "/root/google_cookies.txt"      # Netscape cookies.txt export of the Google account
GOOGLE_EMAIL  = "your.dedicated@gmail.com"      # Google account the person shares their location with
VERCEL_URL    = "https://your-app.vercel.app"   # Your Vercel deployment URL
LOCATION_KEY  = "your_location_key"             # Same value as LOCATION_KEY in Vercel
PERSONS = {                                     # Google display name -> person name in the dashboard
    "Julia Muster": "Julia",
}
POLL_INTERVAL = 180                             # Seconds between polls
# ---------------------

def push_location(person_name, p):
    payload = {
        "lat": p.latitude,
        "lon": p.longitude,
        "tst": int(p.datetime.timestamp()),
        "acc": p.accuracy,
        "address": p.address,
        "batt": p.battery_level,
    }
    r = requests.post(
        f"{VERCEL_URL}/api/location",
        params={"key": LOCATION_KEY, "u": person_name},
        json=payload,
        timeout=15,
    )
    if r.ok:
        print(f"[push] {person_name}: {p.latitude:.5f},{p.longitude:.5f} ({p.address})")
    else:
        print(f"[push] Error for {person_name}: {r.status_code} — {r.text[:200]}")

def poll_once():
    service = Service(cookies_file=COOKIES_FILE, authenticating_account=GOOGLE_EMAIL)
    found = set()
    for p in service.get_shared_people():
        person_name = PERSONS.get(p.full_name)
        if person_name:
            found.add(p.full_name)
            push_location(person_name, p)
    missing = set(PERSONS) - found
    if missing:
        print(f"[google] Not shared with this account (check name/sharing): {', '.join(missing)}")

def main():
    once = "--once" in sys.argv
    print(f"[google] Polling location sharing for: {', '.join(PERSONS.values())}")
    while True:
        try:
            poll_once()
        except InvalidCookies:
            print("[google] Invalid or expired cookies — export a fresh cookies.txt and restart the service.")
        except Exception as e:
            print(f"[Error] {e}")
        if once:
            break
        time.sleep(POLL_INTERVAL)

if __name__ == "__main__":
    main()
