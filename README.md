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
- **Waste Collection (Optional)**: Say *"Alexa, Mülltonne"* and hear which bin goes out next — a scene that triggers a spoken announcement on the Echo you just talked to.
- **Location Feature (Optional)**: Ask *"Alexa, wo ist Julia?"* and get the current location spoken back — fed by a free location-logger app (GPSLogger) posting the phone's position, no extra server component.
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

Waste collection (optional): "Alexa, Mülltonne"
Alexa scene → Vercel → ntfy.sh ("abfall:naechste:<password>") → VPS relay (abfall-relay) → announcement via alexa_remote_control.sh

Location feature (optional): "Alexa, wo ist Julia?"
Phone (GPSLogger, periodic HTTP) → Vercel /api/location → Redis
Alexa Routine "wo ist Julia" → Custom Skill → Vercel /api/skill → zone match / Nominatim → spoken answer

Presence automation (optional): trigger an Alexa routine when everyone is away
VPS cron (abwesenheit-relay) → GET /api/presence?persons=Julia,Stefan&zone=zu%20Hause → all outside home zone → alexa_remote_control.sh -e automation:'0-auf Wiedersehen'

Relay health (optional): let Alexa say why a SmartTag position is stale
VPS cron (smarttag-relay) → POST /api/relay-status → Redis → "wo ist …?" answers "the Samsung login has expired" + dashboard badge
```

**Location-feature endpoints** (all authenticated with `LOCATION_KEY`):

| Endpoint | Purpose |
|---|---|
| `POST/GET /api/location` | Ingest: phone apps and the SmartTag relay report positions here. Besides the position, Mylo reports device state: `ring`/`dnd`/`zen` (ringer mode, policy access, "do not disturb" running), `torch`, `chg`, `net`/`ssid` (connection type and Wi-Fi name), `air` (airplane mode) and `gps` (location services enabled). **A missing field means "unknown", never "no"** — OwnTracks and the SmartTag relay send none of them. With `st=1` the call is a **status report**: it carries no `lat`/`lon`, leaves the last known position untouched and only updates the state fields it actually brought along. That is how a phone whose location services are off still explains itself instead of letting a stale position age without a reason. `st` is an explicit switch rather than "lat/lon are missing", so a GPSLogger call with a forgotten coordinate keeps failing loudly. `boot=1` and `off=1` record `bootedAt`/`offAt` — the phone came back, or it is shutting down |
| `GET /api/presence` | Read-only: reports per person whether their latest (fresh) fix lies inside a named home zone — used by the away automation |
| `POST/GET /api/relay-status` | The SmartTag relay reports its health here; an expired SmartThings session makes Alexa say so instead of reading out a stale position, and the dashboard shows a badge |
| `POST/GET /api/ring` | Sends a command to a person's phone (`?u=<name>&do=<ring\|unmute\|locate>`, default `ring`) as a Firebase push that the Mylo app acts on: **ring** plays an alarm tone even in silent mode, **unmute** takes the phone off silent and raises the ring volume, **locate** makes it report a fresh position right away, **say** has the phone read out a sentence (pass it as `&t=<text>`, max. 200 characters; without it Mylo speaks its built-in default). The announcement text travels as an optional fourth field of the payload, `say:<name>:<tst>:=<percent-encoded>` — the `=` marker sits in front of it because a purely numeric text would otherwise be indistinguishable from the timestamp. Unknown `do` values are rejected rather than forwarded — otherwise the phone would drop a command it does not know while the caller counted it as delivered. Needs `FCM_PROJECT_ID`, `FCM_CLIENT_EMAIL` and `FCM_PRIVATE_KEY`; without them it answers `{ok:false, reason:"fcm_not_configured"}` so the caller can fall back to its ntfy path. The device token needs no separate registration — Mylo sends it as an `X-Fcm-Token` header on every `/api/location` call |

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
| GPSLogger (optional) | Free Android app that posts the phone's location to `/api/location` |
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
| `ADMIN_PASSWORD` | A secret password of your choice. Also the fallback shared secret for the Alexa bridge and the seed for the WoL ntfy topics |
| `BRIDGE_KEY` | *(optional)* Shared secret between the Alexa Lambda and `/api/alexa`. If unset, `ADMIN_PASSWORD` is used instead — either way **the same value must be set as `BRIDGE_KEY` in the Lambda** (see step 3) |
| `LED_TOPIC` | *(optional, LED feature)* ntfy.sh topic the LED relay listens on |
| `LED_PASSWORD` | *(optional, LED feature)* Password expected by the LED relay |
| `LED_CALL_KEY` | **Required if you use the manual `/api/led` endpoint.** The endpoint fails closed: with this variable unset it always answers `401`. Leave it unset to keep `/api/led` disabled — the Alexa LED command and the LED schedule work independently of it |
| `ABFALL_TOPIC` | *(optional, waste feature)* ntfy.sh topic the waste relay listens on |
| `ABFALL_PASSWORD` | *(optional, waste feature)* Password expected by the waste relay |
| `LOCATION_KEY` | *(optional, location feature)* Secret key for the `/api/location` ingest endpoint |
| `ALEXA_SKILL_ID` | *(optional, location feature)* Skill ID of the custom skill (`amzn1.ask.skill....`) |
| `DEFAULT_PERSON` | *(optional, location feature)* Fallback person name (e.g. `Julia`) |

- Deploy and copy your Vercel URL (e.g., `https://your-app.vercel.app`).

#### 3. Alexa & AWS Lambda Integration
- **AWS Lambda**: Create a new function at the [Lambda Console](https://eu-west-1.console.aws.amazon.com/lambda/home?region=eu-west-1#/functions) (Runtime: Node.js 18+).
- Copy the code from `/bridge/lambda_bridge.js` and update the `vercelUrl` variable to your Vercel URL.
- **Set the shared secret** (required — without it Alexa stops working): go to **Configuration → Environment variables** and add
  `BRIDGE_KEY` with **the same value as `ADMIN_PASSWORD`** in Vercel.
  Alexa invokes a Smart Home Lambda directly and passes **no verifiable signature** along, so this header is the only thing standing in front of `/api/alexa`. Without it, anyone who knows your Vercel URL could list your devices (including MAC addresses) and switch your PCs on or off. The endpoint fails closed: no matching header → `401`.
- Add an **Alexa Smart Home** trigger and copy the Lambda **ARN**.

> ⚠️ **If you ever change `ADMIN_PASSWORD` in Vercel, update `BRIDGE_KEY` in the Lambda too** — otherwise `/api/alexa` returns `401` and every voice command fails with a generic "device is not responding". You can also set an independent `BRIDGE_KEY` in Vercel; it takes precedence over `ADMIN_PASSWORD`.
>
> **Troubleshooting:** Lambda → *Monitor → View CloudWatch logs*. `HTTP 401` means the keys differ (watch for a stray space or newline when copying); `Antwort war kein JSON` / a timeout usually means `vercelUrl` still points at the placeholder.

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

#### 7b. (Optional) Waste Collection Announcement

The skill exposes a static virtual **scene "Mülltonne"**. Activating it does not switch anything — it asks the VPS to announce the next waste collection. A scene rather than a switch, so that plain *"Alexa, Mülltonne"* works instead of *"Alexa, turn on Mülltonne"*: it is a question, not a switch.

```
"Alexa, Mülltonne"
  → Vercel /api/alexa (Alexa.SceneController → Activate)
  → ntfy.sh "abfall:naechste:<ABFALL_PASSWORD>"
  → abfall-relay on the VPS
  → announcement on the Echo you just spoke to
```

Alexa only acknowledges the activation; the actual answer arrives a few seconds later as a spoken announcement, on the Echo that last heard a command.

- Set the Vercel environment variables `ABFALL_TOPIC` and `ABFALL_PASSWORD` (see step 2).
- Deploy the relay on the VPS — workflow 30 in [`sKleini/wireguard-vps-strato`](https://github.com/sKleini/wireguard-vps-strato), which also holds the calendar and the announcement itself (workflows 28 and 29). Use the *same* topic and password there.
- Tell Alexa: **"Alexa, discover my devices"** — "Mülltonne" appears as a scene.
- Monitor the relay on the VPS: `journalctl -u abfall-relay -f`

#### 8. (Optional) 📍 Location Feature — "Alexa, wo ist Julia?"

Ask Alexa where a family member currently is and get a spoken answer like *"Julia ist zu Hause, zuletzt aktualisiert vor 5 Minuten."* The location comes from a free, open-source logger app ([GPSLogger](https://gpslogger.app/)) on their Android phone that posts the position directly to your Vercel app — no cloud service in between, no VPS component, no fragile APIs.

**How it works:** GPSLogger sends the phone's location every few minutes to `/api/location`, where it is stored in Redis. A second Alexa skill (type **Custom**, since Smart Home skills cannot speak free-form answers) reads it and answers. Named zones ("zu Hause", "bei der Arbeit") are matched by GPS distance; outside all zones the answer falls back to reverse geocoding via OpenStreetMap/Nominatim.

##### 8.1 GPSLogger on the phone

[GPSLogger](https://gpslogger.app/) is free and open source — install it from [F-Droid](https://f-droid.org/packages/com.mendhak.gpslogger/) or the [Play Store](https://play.google.com/store/apps/details?id=com.mendhak.gpslogger). It can log to a custom URL, so it posts directly to your endpoint with no server-side changes.

1. Install GPSLogger, grant the location permission (**"Allow all the time"**) and disable battery optimization for it when prompted — otherwise Android suspends the periodic updates.
2. **Logging details → Log to custom URL** → enable it and set:
   - **URL**:
     ```
     https://your-app.vercel.app/api/location?key=<LOCATION_KEY>&u=Julia&lat=%LAT&lon=%LON&acc=%ACC&batt=%BATT
     ```
     GPSLogger replaces `%LAT`, `%LON`, `%ACC` and `%BATT` with the live values. Leave the HTTP method at the default (GET) — no request body needed.
3. **Performance** → set a logging interval, e.g. every 900 seconds (15 min); optionally "only log when moved a distance" to save battery.
4. Start logging (▶). After the first fix the dashboard shows the position and the skill can answer.

The `u` parameter must match the person's name in the dashboard (8.2). For more family members, install GPSLogger on each phone with its own `&u=<name>` in the URL. The timestamp is set server-side on arrival, so the spoken "zuletzt aktualisiert vor X Minuten" reflects the last successful upload.

> The endpoint also accepts a JSON `POST` with a `{"lat":…,"lon":…,"acc":…,"batt":…}` body, so apps like [OwnTracks](https://owntracks.org/) work too — point them at the same URL (without the `lat`/`lon` query params).

##### 8.2 Vercel & Dashboard

> 💡 Env vars, persons and zones can be created automatically — see **8.5 Automated setup via GitHub Actions**.

- Add the environment variables `LOCATION_KEY`, `ALEXA_SKILL_ID` (see 8.3) and optionally `DEFAULT_PERSON` in Vercel (see step 2) and redeploy.
- Open the dashboard and add:
  - **Person**: name (e.g. `Julia`), check **Default person** (this is who the "Alexa, wo ist Julia?" routine will answer about).
  - **Zones**: speech-ready name (e.g. `zu Hause`, `bei der Arbeit`), latitude/longitude (right-click in Google Maps copies the coordinates, or use the *"Use my position"* button) and a radius of ~100–200 m. Tick **Home zone** on exactly one of them: the companion Android app reads it from `GET /api/zones` and places a geofence around it, so arrivals and departures are reported within minutes instead of at the next 15-minute tick. The coordinates deliberately live here rather than in that app's build — its APK is distributed publicly, and a home address has no business being compiled into it.
- Once locations arrive, each person in the dashboard shows their last known position — the matched zone (or address/coordinates), the relative age and the battery level, e.g. *"📍 zu Hause · vor 5 Minuten · 🔋 80 %"* — linked to the exact spot on Google Maps. The card refreshes every 60 seconds while the dashboard is open.

##### 8.3 Alexa Custom Skill

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

##### 8.4 Alexa Routine for the exact phrase

To make exactly **"Alexa, wo ist Julia?"** work (without the skill's invocation name):

- Alexa app → **More → Routines → +**
- **When**: *Voice* → `wo ist julia`
- **Action**: *Customized → Skills* → open your custom skill

The skill's launch handler then immediately answers with the location of the **default person**. For other persons use: *"Alexa, frag familien finder, wo [Name] ist"*.

##### 8.5 Automated setup via GitHub Actions

The server-side part of step 8.2 lends itself to automation from any repository: the Vercel env vars can be upserted via `POST https://api.vercel.com/v10/projects/<id>/env?upsert=true`, and persons/zones seeded through `POST /api/manage?type=persons|zones` (both endpoints are idempotent upserts, so such a workflow can be re-run at any time). Keep coordinates and keys in repository secrets so they stay out of the repo and masked in logs.

The remaining steps stay manual: the GPSLogger setup on the phone (8.1), creating the custom skill (8.3) and the Alexa routine (8.4).

---

### 🗣️ Usage

| Command | Action |
|---|---|
| *"Alexa, turn on [Device Name]"* | Sends WoL via VPS → Fritz!Box TR-064 |
| *"Alexa, turn off [Device Name]"* | Sends shutdown command via ntfy.sh → Windows Agent |
| *"Alexa, turn on/off Fritzbox LED"* | Switches the Fritz!Box LED display via ntfy.sh → LED relay |
| *"Alexa, Mülltonne"* | Announces the next waste collection via ntfy.sh → waste relay |
| *"Alexa, wo ist Julia?"* | Speaks the current location of the default person (via routine, see 8.4) |
| *"Alexa, frag familien finder, wo [Name] ist"* | Speaks the current location of any configured person |

The Windows Agent supports **Sleep**, **Shutdown**, and **Hibernate** — configurable in the tray app.

---

### 🛡️ Security & Privacy

All communication between Vercel and your PC/VPS uses [ntfy.sh](https://ntfy.sh) with a unique, unguessable topic ID. This ID is derived from a **SHA-256 hash** of your MAC address + your private `ADMIN_PASSWORD`. No one can trigger your PC without knowing your secret password.

The VPS relay uses local TR-064 (HTTP, port 49000) over the WireGuard tunnel — no Fritz!Box external access is required or enabled.

The optional LED feature uses its own, fully separated chain: a dedicated ntfy.sh topic (`LED_TOPIC`) and password (`LED_PASSWORD`) taken directly from the environment variables (no hashing). The LED relay additionally ignores messages older than 60 seconds or with a wrong password.

The optional waste feature works the same way: its own topic (`ABFALL_TOPIC`) and password (`ABFALL_PASSWORD`), separate from LED and WoL, and a relay that ignores messages older than 60 seconds, with a wrong password, with an unknown action or with an already seen ID.

#### Endpoint protection

- **`/api/alexa` requires the bridge secret.** Every request must carry an `x-bridge-key` header matching `BRIDGE_KEY` (or `ADMIN_PASSWORD` as fallback), compared with `crypto.timingSafeEqual`. Alexa sends no signature to a Smart Home Lambda, so this is the only barrier — see step 3 for the setup. In addition, `endpointId` is validated against the configured devices, so the endpoint can no longer be used as an oracle to derive ntfy topics for arbitrary MAC addresses.
- **All key checks fail closed.** `/api/led`, `/api/location`, `/api/locations`, `/api/presence`, `/api/relay-status`, `/api/manage`, `/api/skill` and `/api/zones` reject the request when their environment variable is missing, instead of comparing `undefined` against `undefined` and letting it pass.
- **`/api/zones` is read-only and behind `LOCATION_KEY`, not `ADMIN_PASSWORD`.** The phones need the home zone to place their geofence, and they already carry that key to post positions; the admin password would additionally unlock device management and wake-on-LAN. Writing zones stays on `/api/manage`.
- **Brute-force protection** on `/api/manage`: after 10 failed attempts per IP the endpoint answers `429` for 15 minutes (counter kept in Redis).
- **Dashboard XSS protection:** every value coming back from the API is HTML-escaped before rendering, and delete buttons use event listeners instead of inline `onclick`. A `Content-Security-Policy` plus `X-Frame-Options`, `X-Content-Type-Options` and `Referrer-Policy` are set in `vercel.json`.
- **Account linking:** `/api/auth` only redirects to Amazon domains, so the endpoint cannot be abused as an open redirect.

> **Note:** `/api/token` still issues a static token — it is not the security boundary. Access control happens at `/api/alexa` via the bridge secret described above.

---

### 📜 License
Licensed under the MIT License. Developed with ❤️ by **FlowersPowerz**.

*If you like this project, please give it a ⭐!*
