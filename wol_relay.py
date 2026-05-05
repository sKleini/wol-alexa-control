import socket
import hashlib
import requests
import json
import time
import struct
import sys

# --- Konfiguration ---
MAC_ADDRESS   = "54:E1:AD:43:6B:29"   # MAC-Adresse des PCs
ADMIN_PASSWORD = "dein_admin_passwort" # Gleicher Wert wie ADMIN_PASSWORD in Vercel
BROADCAST     = "192.168.188.255"      # Subnet-Broadcast deines Heimnetzes
WOL_PORT      = 9
# ---------------------

def send_wol(mac: str, broadcast: str = BROADCAST, port: int = WOL_PORT):
    mac_clean = mac.replace(":", "").replace("-", "").lower()
    if len(mac_clean) != 12:
        raise ValueError(f"Ungültige MAC-Adresse: {mac}")
    magic = bytes.fromhex("ff" * 6 + mac_clean * 16)
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        s.sendto(magic, (broadcast, port))
    print(f"[WoL] Magic Packet gesendet → {mac} via {broadcast}:{port}")

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
                            print("[ntfy] Wake-Befehl empfangen, sende WoL...")
                            send_wol(MAC_ADDRESS)
                        elif msg == "off":
                            pass  # wird von agent.py auf dem Windows-PC verarbeitet
        except Exception as e:
            print(f"[Fehler] {e} – Reconnect in 5s...")
            time.sleep(5)

if __name__ == "__main__":
    listen()
