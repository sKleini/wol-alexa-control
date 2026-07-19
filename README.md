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
- **Fritz!Box LED Control (Optional)**: Virtual Alexa device "Fritzbox LED" to switch the FRITZ!Box LED display on/off by voice — plus a manual HTTP switch (`/api/led`).
- **Location Feature (Optional)**: Ask *"Alexa, wo ist Julia?"* and get the current location spoken back — powered by Google Maps location sharing, no extra app on the phone.
- **100% Free**: Operates entirely within the free tiers of Vercel, Upstash (Redis), and AWS.

---

### 🏗️ Architecture

```
Turn ON (Voice command – no VPS needed):
Alexa (WakeOnLANController) → Echo device (local LAN) → WoL magic packet → PC

Turn ON (Routine – requires a local relay e.g. VPS/Raspberry Pi/NAS):
Alexa Routine → AWS Lambda → Vercel → ntfy.sh ("wake") → Local relay → WoL → PC

Turn ON (Routine – via VPS + WireGuard, as used in this project):
Alexa Routine → AWS Lambda → Vercel → ntfy.sh ("wake") → VPS (WireGuard Tunnel) → Fritz!Box TR-064 → WoL → PC

Turn OFF / Sleep / Hibernate:
Alexa → AWS Lambda → Vercel → ntfy.sh ("off") → Windows Agent (agent.exe) → Sleep/Shutdown/Hibernate

Fritzbox LED (optional):
Alexa ("Fritzbox LED") or GET /api/led → Vercel → ntfy.sh ("led:<on|off>:<password>") → VPS relay (fritzbox-led-relay) → Fritz!Box LED

Location feature (optional): "Alexa, wo ist Julia?"
Phone → Google Maps location sharing → VPS (google_location_relay.py) → Vercel /api/location → Redis
Alexa Routine "wo ist Julia" → Custom Skill → Vercel /api/skill → zone match / address / Nominatim → spoken answer
```

> **Note:** The direct voice path works because the skill registers each device with `Alexa.WakeOnLANController`, which lets the Echo device on the local network send the WoL magic packet without any cloud relay. Alexa Routines use the `PowerController` interface instead, so they always go through the relay path — which can be a VPS with WireGuard, or any local device (Raspberry Pi, NAS, etc.) that runs `wol_relay.py` and has access to the local network.

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
| LED relay (optional) | VPS service (`fritzbox-led-relay`) that switches the Fritz!Box LED display |
| Location relay (optional) | VPS service (`google_location_relay.py`) that polls Google Maps location sharing |
| Alexa Custom Skill (optional) | Second skill that answers "Wo ist [Person]?" with a spoken location |

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
| `LED_TOPIC` | *(optional, LED feature)* ntfy.sh topic the LED relay listens on |
| `LED_PASSWORD` | *(optional, LED feature)* Password expected by the LED relay |
| `LED_CALL_KEY` | *(optional, LED feature)* Secret key for the manual `/api/led` endpoint |
| `LOCATION_KEY` | *(optional, location feature)* Secret key for the `/api/location` ingest endpoint |
| `ALEXA_SKILL_ID` | *(optional, location feature)* Skill ID of the custom skill (`amzn1.ask.skill....`) |
| `DEFAULT_PERSON` | *(optional, location feature)* Fallback person name (e.g. `Julia`) |

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

#### 7. (Optional) Fritz!Box LED Control

The skill exposes a static virtual device **"Fritzbox LED"** (shown as a light in the Alexa app) that switches the LED display of your FRITZ!Box. It requires a separate relay service on the VPS (`fritzbox-led-relay`) that listens on its own ntfy.sh topic and toggles the LED when a message in the format `led:<on|off>:<password>` arrives. Messages older than 60 s or with a wrong password are ignored by the relay.

- Set the Vercel environment variables `LED_TOPIC`, `LED_PASSWORD`, and `LED_CALL_KEY` (see step 2).
- Tell Alexa: **"Alexa, discover my devices"** — "Fritzbox LED" appears as a light.
- The LED can also be switched manually without Alexa:
  ```
  GET https://your-app.vercel.app/api/led?action=on|off&key=<LED_CALL_KEY>
  ```
- Monitor the relay on the VPS: `journalctl -u fritzbox-led-relay -f`

#### 8. (Optional) 📍 Location Feature — "Alexa, wo ist Julia?"

Ask Alexa where a family member currently is and get a spoken answer like *"Julia ist zu Hause, zuletzt aktualisiert vor 5 Minuten."* — **without installing any app on their phone**. The location comes from the built-in **Google Maps location sharing** of their Android phone.

> ⚠️ **Note:** There is no official Google API for location sharing. The relay uses the community library [`locationsharinglib`](https://github.com/costastf/locationsharinglib), which reads the sharing data via session cookies of a Google account. This works reliably, but Google may expire the cookies from time to time — then you have to export a fresh `cookies.txt` (see troubleshooting below).

**How it works:** The phone shares its location with a Google account (built-in Google Maps feature). A small relay on the VPS polls that account every few minutes and pushes the location to Vercel (`/api/location`), where it is stored in Redis. A second Alexa skill (type **Custom**, since Smart Home skills cannot speak free-form answers) reads it and answers. Named zones ("zu Hause", "bei der Arbeit") are matched by GPS distance; outside all zones the answer falls back to the address provided by Google, or reverse geocoding via OpenStreetMap/Nominatim.

##### 8.1 Google location sharing

1. **Recommended:** create a *dedicated* Google account for this (the session cookies will live on your VPS — don't use your main account).
2. On the phone of the person to locate: **Google Maps → profile picture → Location sharing → New share** → select the dedicated account → **"Until you turn this off"**.
3. On your PC: log in to [google.com](https://www.google.com) with the dedicated account, open Google Maps once (the shared person should be visible), then export the cookies as `cookies.txt` in Netscape format (browser extension, e.g. *"Get cookies.txt LOCALLY"*).
4. Copy the file to the VPS, e.g. `/root/google_cookies.txt`.

##### 8.2 VPS location relay

> 💡 This whole step can be automated — see **8.6 Automated setup via GitHub Action**.

```bash
pip3 install locationsharinglib requests

curl -O https://raw.githubusercontent.com/sKleini/wol-alexa-control/main/google_location_relay.py
nano google_location_relay.py
```

Set these values in `google_location_relay.py`:

| Variable | Value |
|---|---|
| `COOKIES_FILE` | Path to the exported `cookies.txt` |
| `GOOGLE_EMAIL` | E-mail of the dedicated Google account |
| `VERCEL_URL` | Your Vercel URL (e.g. `https://your-app.vercel.app`) |
| `LOCATION_KEY` | Same value as `LOCATION_KEY` in Vercel |
| `PERSONS` | Google display name → dashboard person name, e.g. `{"Julia Muster": "Julia"}` |

Test with a single run (`--once`), then install as a systemd service:

```bash
python3 google_location_relay.py --once
```
```bash
nano /etc/systemd/system/google-location-relay.service
```
```ini
[Unit]
Description=Google Location Relay
After=network.target

[Service]
ExecStart=/usr/bin/python3 -u /root/google_location_relay.py
Restart=always
RestartSec=30

[Install]
WantedBy=multi-user.target
```
```bash
systemctl daemon-reload
systemctl enable --now google-location-relay
journalctl -u google-location-relay -f
```

**Troubleshooting:** If the log shows `Invalid or expired cookies`, log in to the dedicated Google account again in your browser, export a fresh `cookies.txt`, copy it to the VPS and restart the service.

##### 8.3 Vercel & Dashboard

> 💡 Env vars, persons and zones can be created automatically — see **8.6 Automated setup via GitHub Action**.

- Add the environment variables `LOCATION_KEY`, `ALEXA_SKILL_ID` (see 8.4) and optionally `DEFAULT_PERSON` in Vercel (see step 2) and redeploy.
- Open the dashboard and add:
  - **Person**: name (e.g. `Julia`), check **Default person** (this is who the "Alexa, wo ist Julia?" routine will answer about).
  - **Zones**: speech-ready name (e.g. `zu Hause`, `bei der Arbeit`), latitude/longitude (right-click in Google Maps copies the coordinates, or use the *"Use my position"* button) and a radius of ~100–200 m.

##### 8.4 Alexa Custom Skill

1. [Alexa Developer Console](https://developer.amazon.com/alexa/console/ask) → **Create Skill** → type **Custom**, language **German (DE)**, hosting **Provision your own**.
2. **Invocation name**: e.g. `familien finder`.
3. Open the **JSON Editor** under *Interaction Model* and paste (add one slot value per person):

```json
{
  "interactionModel": {
    "languageModel": {
      "invocationName": "familien finder",
      "intents": [
        { "name": "AMAZON.CancelIntent", "samples": [] },
        { "name": "AMAZON.HelpIntent", "samples": [] },
        { "name": "AMAZON.StopIntent", "samples": [] },
        { "name": "AMAZON.NavigateHomeIntent", "samples": [] },
        {
          "name": "WhereIsPersonIntent",
          "slots": [{ "name": "person", "type": "PERSON_NAME" }],
          "samples": [
            "wo ist {person}",
            "wo {person} ist",
            "wo {person} gerade ist",
            "wo sich {person} befindet",
            "nach dem standort von {person}",
            "sag mir wo {person} ist"
          ]
        }
      ],
      "types": [
        {
          "name": "PERSON_NAME",
          "values": [{ "name": { "value": "Julia" } }]
        }
      ]
    }
  }
}
```

4. **Build the model**.
5. **Endpoint** → **HTTPS** → Default region: `https://your-app.vercel.app/api/skill` → SSL certificate type: *"My development endpoint is a sub-domain of a domain that has a wildcard certificate from a certificate authority"*.
6. Copy the **Skill ID** (`amzn1.ask.skill....`) into the `ALEXA_SKILL_ID` environment variable in Vercel and redeploy.
7. The skill works on all Echo devices of the same Amazon account while it stays in **Development** mode — no publishing needed. Test it in the **Test** tab (set to *Development*): type `frag familien finder wo julia ist`.

> The endpoint verifies the skill ID and rejects stale requests. Full Alexa request-signature verification (required for certification) is not implemented — fine for a private skill in development mode.

##### 8.5 Alexa Routine for the exact phrase

To make exactly **"Alexa, wo ist Julia?"** work (without the skill's invocation name):

- Alexa app → **More → Routines → +**
- **When**: *Voice* → `wo ist julia`
- **Action**: *Customized → Skills* → open your custom skill

The skill's launch handler then immediately answers with the location of the **default person**. For other persons use: *"Alexa, frag familien finder, wo [Name] ist"*.

##### 8.6 Automated setup via GitHub Action

Instead of doing 8.2 (VPS relay) and 8.3 (Vercel env vars, persons, zones) by hand, the workflow **Setup Location Feature** (`.github/workflows/setup-location.yml`) does them for you. It can be re-run at any time — all operations are idempotent upserts.

**1. Add these secrets** in your fork under *Settings → Secrets and variables → Actions → New repository secret*:

| Secret | Value | Used for |
|---|---|---|
| `LOCATION_KEY` | A secret of your choice for the `/api/location` ingest endpoint | Vercel, VPS |
| `VERCEL_TOKEN` | Vercel account token ([vercel.com → Account Settings → Tokens](https://vercel.com/account/tokens)) | Vercel |
| `VERCEL_PROJECT_ID` | Project ID (Vercel project → Settings → General) | Vercel |
| `VERCEL_TEAM_ID` | *(optional)* only for team-scoped projects | Vercel |
| `VERCEL_DEPLOY_HOOK` | *(optional)* Deploy hook URL (project → Settings → Git → Deploy Hooks) — enables automatic redeploy | Vercel |
| `ALEXA_SKILL_ID` | *(initially omit)* Skill ID after creating the custom skill (8.4) | Vercel |
| `ADMIN_PASSWORD` | Your existing dashboard password | Seeding |
| `VPS_HOST` | IP or hostname of the VPS | VPS |
| `VPS_USER` | SSH user (e.g. `root`) | VPS |
| `VPS_PORT` | *(optional)* SSH port, default 22 | VPS |
| `VPS_SSH_KEY` | Full private SSH key content (e.g. ed25519) authorized on the VPS | VPS |
| `GOOGLE_EMAIL` | E-mail of the dedicated Google account (8.1) | VPS |
| `GOOGLE_COOKIES_B64` | `base64 -w0 cookies.txt` of the exported cookies (8.1) | VPS |
| `PERSONS_MAP` | JSON object mapping Google display name → dashboard name, e.g. `{"Julia Muster": "Julia"}` | VPS, Seeding |
| `SETUP_ZONES` | JSON array of zones, e.g. `[{"name":"zu Hause","lat":51.5123,"lng":7.4567,"radius":150}]` | Seeding |

Storing coordinates, cookies and keys as secrets keeps them out of the repository and masked in the workflow logs.

**2. Run the workflow**: *Actions → Setup Location Feature → Run workflow*. Enter your Vercel app URL and the default person; the three checkboxes let you run only parts of the setup.

**3. Remaining manual steps** (no APIs exist for these): Google location sharing on the phone + cookie export (8.1), creating the custom skill (8.4 — then add `ALEXA_SKILL_ID` as secret and re-run the workflow with only *Vercel* checked), and the Alexa routine (8.5).

---

### 🗣️ Usage

| Command | Action |
|---|---|
| *"Alexa, turn on [Device Name]"* | Sends WoL via VPS → Fritz!Box TR-064 |
| *"Alexa, turn off [Device Name]"* | Sends shutdown command via ntfy.sh → Windows Agent |
| *"Alexa, turn on/off Fritzbox LED"* | Switches the Fritz!Box LED display via ntfy.sh → LED relay |
| *"Alexa, wo ist Julia?"* | Speaks the current location of the default person (via routine, see 8.5) |
| *"Alexa, frag familien finder, wo [Name] ist"* | Speaks the current location of any configured person |

The Windows Agent supports **Sleep**, **Shutdown**, and **Hibernate** — configurable in the tray app.

---

### 🛡️ Security & Privacy

All communication between Vercel and your PC/VPS uses [ntfy.sh](https://ntfy.sh) with a unique, unguessable topic ID. This ID is derived from a **SHA-256 hash** of your MAC address + your private `ADMIN_PASSWORD`. No one can trigger your PC without knowing your secret password.

The VPS relay uses local TR-064 (HTTP, port 49000) over the WireGuard tunnel — no Fritz!Box external access is required or enabled.

The optional LED feature uses its own, fully separated chain: a dedicated ntfy.sh topic (`LED_TOPIC`) and password (`LED_PASSWORD`) taken directly from the environment variables (no hashing). The LED relay additionally ignores messages older than 60 seconds or with a wrong password.

---

### 📜 License
Licensed under the MIT License. Developed with ❤️ by **FlowersPowerz**.

*If you like this project, please give it a ⭐!*
