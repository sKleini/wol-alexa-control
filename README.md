# 🐕 WOL-Alexa-Full-Control

**The ultimate, free, and secure way to Turn ON, OFF, or SLEEP your PCs via Alexa.** 🚀🖥️

Tired of paid Alexa skills or complex setups? This project allows you to create your own **Private Smart Home Skill** to manage your computers using your Amazon Echo. No physical hardware bridge required—just the cloud and a lightweight Windows agent.

---

### 🔥 Key Features:
- **Full Power Control**: Turn ON (Wake-on-LAN) and Turn OFF / SLEEP / HIBERNATE your PC.
- **Multi-Device Support**: Manage as many computers as you want (e.g., "Alexa, turn on Gaming PC", "Alexa, turn off Office").
- **Windows Agent (Ready to use)**: Pre-compiled executable that lives in your system tray.
- **Secure SHA-256 Bridge**: Encrypted communication between Alexa and your PC using your private hash.
- **Modern Dashboard**: Sleek *Glassmorphism* interface to manage your devices.
- **100% Free**: Operates entirely within the free tiers of Vercel, Upstash (Redis), and AWS.

---

### 🏗️ Architecture

```
Turn ON (Voice command – no VPS needed):
Alexa (WakeOnLANController) → Echo device (local LAN) → WoL magic packet → PC

Turn ON (Routine – requires VPS):
Alexa Routine → AWS Lambda → Vercel → ntfy.sh ("wake") → VPS (WireGuard Tunnel) → Fritz!Box TR-064 → WoL → PC

Turn OFF / Sleep / Hibernate:
Alexa → AWS Lambda → Vercel → ntfy.sh ("off") → Windows Agent (agent.exe) → Sleep/Shutdown/Hibernate
```

> **Note:** The direct voice path works because the skill registers each device with `Alexa.WakeOnLANController`, which lets the Echo device on the local network send the WoL magic packet without any cloud relay. Alexa Routines use the `PowerController` interface instead, so they always go through the VPS path.

**Components:**
| Component | Purpose |
|---|---|
| Vercel | Hosts the Alexa Smart Home Skill backend |
| AWS Lambda | Bridges Alexa to Vercel |
| Upstash Redis | Stores the list of managed devices |
| ntfy.sh | Secure pub/sub message relay |
| Windows Agent | Receives "off" commands, executes sleep/shutdown |
| VPS + WireGuard | Relays "wake" commands from ntfy.sh to Fritz!Box |
| Fritz!Box TR-064 | Sends WoL magic packet to the PC on the local network |

---

### 🚀 Step-by-Step Setup Guide

#### 1. Database Setup (Upstash Redis)
- Sign up at [Upstash](https://upstash.com).
- Create a new **Redis** database.
- Copy `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` from the REST API section.

#### 2. Cloud Deployment (Vercel)
- Fork/Clone this repository to your GitHub.
- Create a new project in [Vercel](https://vercel.com) and connect your repository.
- Go to **Environment Variables** and add:

| Variable | Value |
|---|---|
| `UPSTASH_REDIS_REST_URL` | from Upstash |
| `UPSTASH_REDIS_REST_TOKEN` | from Upstash |
| `ADMIN_PASSWORD` | A secret password of your choice |

- Deploy and copy your Vercel URL (e.g., `https://your-app.vercel.app`).

#### 3. Alexa & AWS Lambda Integration
- **AWS Lambda**: Create a new function at the [Lambda Console](https://eu-west-1.console.aws.amazon.com/lambda/home?region=eu-west-1#/functions) (Runtime: Node.js 18+).
- Copy the code from `/bridge/lambda_bridge.js` and update the `vercelUrl` variable to your Vercel URL.
- Add an **Alexa Smart Home** trigger and copy the Lambda **ARN**.

- **Alexa Developer Console**: Create a new **Smart Home** skill at the [Alexa Skills Kit Console](https://developer.amazon.com/alexa/console/ask).
  - **Smart Home Service Endpoint**: paste your Lambda ARN.
  - **Account Linking**:
    - Authorization URI: `https://your-app.vercel.app/api/auth`
    - Access Token URI: `https://your-app.vercel.app/api/token`
    - Client ID: `anything`
    - Client Secret: `anything`

#### 4. Windows Agent (Turn OFF / Sleep / Hibernate)
- Download `agent.exe` from the [Releases](https://github.com/sKleini/wol-alexa-control/releases/tag/v0.0.1) section.
- Run it on the PC you want to control.
- Enter the **MAC Address** of the PC (must match the dashboard entry).
- Enter the **Security Key** (`ADMIN_PASSWORD` from Vercel).
- Click **Connect & Save** — the agent minimizes to the system tray.
- Optional: enable **Launch at Windows Startup**.

#### 5. VPS Relay for Wake-on-LAN (Turn ON)

Wake-on-LAN from the cloud requires a relay with access to your local network. This is done via a VPS that has a permanent **WireGuard VPN tunnel** to your home network (Fritz!Box).

**Prerequisites:**
- A VPS (e.g., Strato, Hetzner, Oracle Free Tier) with Python 3 and `requests` installed.
- A permanent WireGuard tunnel from the VPS to your Fritz!Box LAN.
- The VPS must be able to reach `192.168.188.1:49000` (Fritz!Box TR-064) through the tunnel.

**Verify tunnel connectivity:**
```bash
curl -s http://192.168.188.1:49000/tr64desc.xml | head -5
# Should return XML — if so, TR-064 is reachable
```

**Install and configure the relay:**
```bash
# Download the relay script
curl -O https://raw.githubusercontent.com/sKleini/wol-alexa-control/main/wol_relay.py

# Edit configuration
nano wol_relay.py
```

Set these values in `wol_relay.py`:

| Variable | Value |
|---|---|
| `MAC_ADDRESS` | MAC address of the PC to wake |
| `ADMIN_PASSWORD` | Same value as `ADMIN_PASSWORD` in Vercel |
| `FRITZBOX_IP` | Fritz!Box LAN IP (e.g. `192.168.188.1`) |
| `FRITZBOX_USER` | Fritz!Box username (leave empty if none) |
| `FRITZBOX_PASSWORD` | Fritz!Box web UI password |

**Test TR-064 WoL manually:**
```bash
python3 -c "
import requests
from requests.auth import HTTPDigestAuth
body = '''<?xml version=\"1.0\" encoding=\"utf-8\"?>
<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\">
  <s:Body>
    <u:X_AVM-DE_WakeOnLANByMACAddress xmlns:u=\"urn:dslforum-org:service:Hosts:1\">
      <NewMACAddress>AA:BB:CC:DD:EE:FF</NewMACAddress>
    </u:X_AVM-DE_WakeOnLANByMACAddress>
  </s:Body>
</s:Envelope>'''
r = requests.post('http://192.168.188.1:49000/upnp/control/hosts',
    data=body,
    headers={'Content-Type':'text/xml; charset=\"utf-8\"','SOAPAction':'\"urn:dslforum-org:service:Hosts:1#X_AVM-DE_WakeOnLANByMACAddress\"'},
    auth=HTTPDigestAuth('', 'FRITZBOX_PASSWORD'))
print(r.status_code, r.text[:200])
"
```

**Install as systemd service (auto-start):**
```bash
nano /etc/systemd/system/wol-relay.service
```
```ini
[Unit]
Description=WoL Relay via ntfy.sh
After=network.target

[Service]
ExecStart=/usr/bin/python3 -u /root/wol_relay.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```
```bash
systemctl daemon-reload
systemctl enable --now wol-relay
systemctl status wol-relay

# Monitor logs
journalctl -u wol-relay -f
```

> **Note:** After any change to the service file, reload and restart:
> ```bash
> systemctl daemon-reload && systemctl restart wol-relay
> ```

The relay listens on ntfy.sh and logs: `[ntfy] Listening on topic: wol_xxxxxxxxxxxxxxxxxx`

#### 6. Add Devices & Discover
- Open your Vercel URL and log in with your `ADMIN_PASSWORD`.
- Add your PC's **name** and **MAC address**.
- Tell Alexa: **"Alexa, discover my devices"**.

---

### 🗣️ Usage

| Command | Action |
|---|---|
| *"Alexa, turn on [Device Name]"* | Sends WoL via VPS → Fritz!Box TR-064 |
| *"Alexa, turn off [Device Name]"* | Sends shutdown command via ntfy.sh → Windows Agent |

The Windows Agent supports **Sleep**, **Shutdown**, and **Hibernate** — configurable in the tray app.

---

### 🛡️ Security & Privacy

All communication between Vercel and your PC/VPS uses [ntfy.sh](https://ntfy.sh) with a unique, unguessable topic ID. This ID is derived from a **SHA-256 hash** of your MAC address + your private `ADMIN_PASSWORD`. No one can trigger your PC without knowing your secret password.

The VPS relay uses local TR-064 (HTTP, port 49000) over the WireGuard tunnel — no Fritz!Box external access is required or enabled.

---

### 📜 License
Licensed under the MIT License. Developed with ❤️ by **FlowersPowerz**.

*If you like this project, please give it a ⭐!*
