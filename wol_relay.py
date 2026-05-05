import hashlib
import requests
from requests.auth import HTTPDigestAuth
import json
import time

# --- Konfiguration ---
MAC_ADDRESS      = "54:E1:AD:43:6B:29"   # MAC-Adresse des PCs
ADMIN_PASSWORD   = "dein_admin_passwort"  # Gleicher Wert wie ADMIN_PASSWORD in Vercel
FRITZBOX_IP      = "192.168.188.1"        # Fritz!Box LAN-IP
FRITZBOX_USER    = ""                     # Fritz!Box Benutzername (leer = kein Benutzer)
FRITZBOX_PASSWORD = "dein_fritzbox_passwort"  # Fritz!Box Passwort
# ---------------------

SOAP_BODY = """<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"
            s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:X_AVM-DE_WakeOnLANByMACAddress xmlns:u="urn:dslforum-org:service:Hosts:1">
      <NewMACAddress>{mac}</NewMACAddress>
    </u:X_AVM-DE_WakeOnLANByMACAddress>
  </s:Body>
</s:Envelope>"""

def send_wol_tr064(mac: str):
    url = f"http://{FRITZBOX_IP}:49000/upnp/control/hosts"
    body = SOAP_BODY.format(mac=mac.upper().replace("-", ":"))
    headers = {
        "Content-Type": 'text/xml; charset="utf-8"',
        "SOAPAction": '"urn:dslforum-org:service:Hosts:1#X_AVM-DE_WakeOnLANByMACAddress"',
    }
    r = requests.post(
        url, data=body, headers=headers,
        auth=HTTPDigestAuth(FRITZBOX_USER, FRITZBOX_PASSWORD),
        timeout=10
    )
    if r.ok:
        print(f"[TR-064] WoL gesendet für {mac}")
    else:
        print(f"[TR-064] Fehler: {r.status_code} — {r.text[:200]}")

def get_topic(mac: str, password: str) -> str:
    clean = mac.replace(":", "").replace("-", "").replace(" ", "").lower()
    return "wol_" + hashlib.sha256((clean + password).encode()).hexdigest()[:20]

def listen():
    topic = get_topic(MAC_ADDRESS, ADMIN_PASSWORD)
    url   = f"https://ntfy.sh/{topic}/json"
    print(f"[ntfy] Lausche auf Topic: {topic}")

    while True:
        try:
            with requests.get(url, stream=True, timeout=60) as r:
                for line in r.iter_lines():
                    if not line:
                        continue
                    try:
                        data = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if data.get("event") == "message":
                        msg = data.get("message", "").strip().lower()
                        if msg == "wake":
                            print("[ntfy] Wake-Befehl empfangen, sende WoL via TR-064...")
                            send_wol_tr064(MAC_ADDRESS)
                        # "off" wird von agent.py auf dem Windows-PC verarbeitet
        except Exception as e:
            print(f"[Fehler] {e} – Reconnect in 5s...")
            time.sleep(5)

if __name__ == "__main__":
    listen()
