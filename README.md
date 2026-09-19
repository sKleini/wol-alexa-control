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
- **Location Feature (Optional)**: Ask *"Alexa, wo ist Julia?"* and get the current location spoken back — or have the phone ring, after Alexa asks you to confirm — fed by a free location-logger app (GPSLogger) posting the phone's position, no extra server component.
- **Meine Plattenkiste (Optional)**: Say *"Alexa, öffne meine plattenkiste und spiele Kinderlieder"* and the Echo plays a playlist you manage in the dashboard — a name plus a list of MP3 URLs — in order or shuffled, with repeat, the spoken confirmation and resuming where it stopped each switchable per playlist. No media server, no NAS: the Echo streams straight from the URLs.
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

Meine Plattenkiste (optional): "Alexa, öffne meine plattenkiste und spiele Kinderlieder"
Dashboard → POST /api/manage?type=playlists → Redis (name + MP3 URLs)
Custom Skill "Meine Plattenkiste" → /api/skill (same endpoint, routed by skill ID) → AudioPlayer.Play → Echo streams the MP3 from its URL
```

**Location-feature endpoints** (all authenticated with `LOCATION_KEY`):

| Endpoint | Purpose |
|---|---|
| `POST/GET /api/location` | Ingest: phone apps and the SmartTag relay report positions here. Besides the position, Mylo reports device state: `ring`/`dnd`/`zen` (ringer mode, policy access, "do not disturb" running), `torch`, `chg`, `net`/`ssid` (connection type and Wi-Fi name), `air` (airplane mode), `gps` (location services enabled), `ovl` (may Mylo draw an overlay message), `vol` (per-channel volumes), `ver` (app version), `takt` (effective reporting interval in minutes), `zonen` (how many geofences the device actually holds) and `mov` (`unterwegs`/`ruhend` — is the device moving or lying still). **`mov` is what explains an old position**: since Mylo derives its reporting interval from movement (15 min moving, 120 min at rest), "2 hours ago" means either "resting, reporting on schedule" or "not reporting any more", and those looked identical before. **A missing field means "unknown", never "no"** — OwnTracks and the SmartTag relay send none of them. With `st=1` the call is a **status report**: it carries no `lat`/`lon`, leaves the last known position untouched and only updates the state fields it actually brought along. That is how a phone whose location services are off still explains itself instead of letting a stale position age without a reason. `st` is an explicit switch rather than "lat/lon are missing", so a GPSLogger call with a forgotten coordinate keeps failing loudly. `boot=1` and `off=1` record `bootedAt`/`offAt` — the phone came back, or it is shutting down. **Zone changes are detected here**, comparing the stored record against the incoming position (`findZone` for both): entering or leaving a named zone fans out a data-only Firebase push `zone-enter:<name>:<tst>:=<zone>` (or `zone-exit:…`) to every registered Actions-Hub device, so the notification arrives in seconds instead of on the app's next poll. No previous record means no change — the first report stays silent. The push never fails the ingest: the position is stored either way |
| `GET /api/presence` | Read-only: reports per person whether their latest (fresh) fix lies inside a named home zone — used by the away automation |
| `POST/GET /api/relay-status` | The SmartTag relay reports its health here; an expired SmartThings session makes Alexa say so instead of reading out a stale position, and the dashboard shows a badge |
| `POST/GET /api/ring` | Sends a command to a person's phone (`?u=<name>&do=<ring\|unmute\|locate>`, default `ring`) as a Firebase push that the Mylo app acts on: **ring** plays an alarm tone even in silent mode, **unmute** takes the phone off silent and raises the ring volume, **locate** makes it report a fresh position right away, **say** has the phone read out a sentence (pass it as `&t=<text>`, max. 200 characters; without it Mylo speaks its built-in default). The announcement text travels as an optional fourth field of the payload, `say:<name>:<tst>:=<percent-encoded>` — the `=` marker sits in front of it because a purely numeric text would otherwise be indistinguishable from the timestamp. Unknown `do` values are rejected rather than forwarded — otherwise the phone would drop a command it does not know while the caller counted it as delivered. Needs `FCM_PROJECT_ID`, `FCM_CLIENT_EMAIL` and `FCM_PRIVATE_KEY`; without them it answers `{ok:false, reason:"fcm_not_configured"}` so the caller can fall back to its ntfy path. The device token needs no separate registration — Mylo sends it as an `X-Fcm-Token` header on every `/api/location` call, and the Actions Hub does the same on `/api/locations` (kept in the `hub_fcm` hash, pruned after 30 days without contact) |

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
| Meine Plattenkiste skill (optional) | Third skill (Custom, AudioPlayer) that plays the MP3 playlists from the dashboard — shares the `/api/skill` endpoint |

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
| `MUSIK_SKILL_ID` | *(optional, Meine Plattenkiste)* Skill ID of the **Meine Plattenkiste** custom skill (`amzn1.ask.skill....`, see section 9). Both custom skills point at `/api/skill`; this ID is how the endpoint tells them apart |
| `MUSIK_VORLAUF_MS` | *(optional, Meine Plattenkiste)* How far *Resume* rewinds behind the remembered spot, in milliseconds, in its **Audiobook** setting. Default `5000`; `0` resumes on the exact millisecond. No effect on **Album**, which always restarts the track. Re-read on every request, like `MUSIK_BUDGET_MS` |

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
3. Open the **JSON Editor** under *Interaction Model* and paste the contents of
   [`alexa/interaction-model.de-DE.json`](alexa/interaction-model.de-DE.json) — **add one slot
   value under `PERSON_NAME` per person**. A name that is missing there is never recognised, and
   the skill answers *"Ich habe keine Person namens … gefunden."*

   The model defines three intents: `WhereIsPersonIntent` (speaks the location), `RingPersonIntent`
   (makes the phone ring) and `SilencePersonIntent` (stops sound, torch and announcement).

> **The confirmation before ringing lives in the `dialog` section, not next to the intent in
> `languageModel`.** That is not a matter of taste: in the other place the console accepts the
> field but never evaluates it — the question would not be asked and the phone would ring straight
> away, which is exactly what it is there to prevent.
>
> `delegationStrategy` is `SKILL_RESPONSE`, so Alexa hands the intent to `api/skill.js`, which
> answers with a `Dialog.ConfirmIntent` directive carrying the person's name. The question lives in
> the code, not in two versions in two places. And should the dialog section ever go missing, the
> skill still asks back on its own rather than ringing — a configuration slip must not surface as
> the very thing it is meant to prevent.
>
> `SilencePersonIntent` deliberately has **no** confirmation: stopping is harmless, and whoever
> just found the ringing phone should not have to answer a question first.

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

#### 9. (Optional) 🎵 Meine Plattenkiste — "Alexa, öffne meine plattenkiste und spiele Kinderlieder"

Play your own MP3s on any Echo: a playlist is a **name plus a list of URLs**, managed in the dashboard. The Echo streams each file straight from its URL, so there is no media server, no NAS access and no VPS component — only the URLs have to be reachable from the internet. Four settings per playlist decide how it behaves. **Repeat** says what happens after the last track: start over and keep going until you say *"Alexa, Stopp"*, or end there. **Announce** says whether Alexa confirms with *"Ich spiele …"* before the first track, or the music simply starts. **Shuffle** randomises the order, and **Resume** decides whether — and how precisely — the playlist picks up where it stopped.

**How it works:** the dashboard stores playlists in Redis (`musik_playlists`, plus `musik_stand` for the resume marks). A third Alexa skill (type **Custom**, with the **AudioPlayer** interface) reads them and answers every `PlayPlaylistIntent` with an `AudioPlayer.Play` directive. As soon as her queue has room Alexa asks the skill for the next track (`PlaybackNearlyFinished`) and gets it enqueued — after the last one, the first again. The state lives in the stream token (`<playlist>|<track>|<round>`), not in the database, so nothing can go stale — the one exception is the resume mark, which is the one thing a token cannot carry across a silent night.

> **Why the skill shares `/api/skill` with "familien finder".** Vercel's Hobby plan allows twelve serverless functions and `api/` has exactly twelve (the `API-Funktionen zaehlen` workflow enforces it). The logic therefore lives in `lib/musik.js`; `api/skill.js` routes by skill ID and `api/manage.js` serves the dashboard under `?type=playlists`.

##### 9.1 Where the MP3s can live

Alexa fetches the files itself — without your login, without cookies. Every URL must therefore be

- **`https://`** with a certificate from a public CA (no self-signed, no plain `http://`). Amazon documents port 443, but a non-standard port works in practice — a FRITZ!Box share on its default port 456 plays fine,
- a **direct link to the file** (`Content-Type: audio/mpeg`), not a preview or share page: Dropbox needs `?dl=1`, Nextcloud share links need `/download` appended, Google Drive shares usually fail,
- ideally on a host that answers **range requests** (`206 Partial Content`) — without them *"Alexa, weiter"* after a pause restarts the track from the beginning.

Your own web space, a Nextcloud/ownCloud, an S3 bucket or any static file host works. The dashboard's **Check URLs** button fetches every link the way the Echo does and reports status, content type, range support and the port, so you see problems before Alexa turns them into silence.

**A FRITZ!Box works too**, on its default HTTPS port 456 — the certificate of a `…myfritz.net` address comes from a public CA, which is the part that matters. Keep in mind that Alexa then fetches the files over your upstream bandwidth, and that a share link is public to anyone who has it.

##### 9.2 Import a whole folder

One link instead of twenty: paste a **folder share link** into *Import folder* above the track list and every audio file listed behind it is added as its own track, in the order the page lists them.

- Works with a **Nextcloud folder share** and a plain **directory index** of an Apache or nginx — and with a **FRITZ!NAS folder share** (`https://…myfritz.net:456/nas/filelink.lua?id=…`, created in FRITZ!NAS via *Select → Share*), which takes its own route; see below.
- The server fetches the page (the dashboard cannot: its CSP is `connect-src 'self'`) and collects the addresses of files ending in `.mp3`, `.m4a`, `.m4b`, `.mp4`, `.aac` or `.mpga` — from the links first, and from an embedded JSON block only if the page has no links of its own. It reads the shared folder itself, not its subfolders.
- Nothing is saved. The tracks land in the textarea below, appended to what is already there, so two folders can be combined and single lines removed before **Save Playlist**. Importing the same folder twice adds nothing twice.
- A link that points at a single file instead of a folder is imported as that one track and says so. A page that lists its files but builds their addresses in the browser cannot be imported — the answer names that case rather than reporting an empty folder.
##### FRITZ!NAS folder shares

A FRITZ!NAS share link opens an empty page — a `<div id="app">` and two scripts. The file list is fetched by the browser afterwards, so there is nothing in the source to parse. `lib/fritznas.js` therefore walks the same route the browser does: open the share link, pick up the session number, ask `data.lua` for the listing, and assemble one stream address per track (`/nas/cgi-bin/luacgi_notimeout?script=/api/data.lua&sid=…&c=music&a=get&path=…`). That address is a plain GET without a cookie and supports range requests — the one form the Echo can load.

AVM documents none of this, so the call that returns the listing is **tried rather than assumed**: a handful of plausible controller/action pairs in turn, until one answers with files. The import then fetches the first track exactly the way the Echo would — no cookie, `Range: bytes=0-0` — and only reports success if a real audio file comes back. Every step appears as a line under the field, so a FRITZ!OS update that renames something produces a usable message instead of an empty result.

**The addresses carry a session number, and the FRITZ!Box forgets a session after roughly twenty minutes of quiet** — so a stored one would only be good for the evening it was imported. The playlist therefore also stores where it came from, and the skill swaps `sid=` for a current one before every answer. The path to the file never changes, only the number in it, so a FRITZ!NAS playlist stays an ordinary list of URLs and only one place in the skill knows about any of this.

**The box keeps one NAS session, and that shapes what is possible.** AVM's technical note on session IDs is explicit: the number of sessions is limited, a program should use only one per box — and an access *without* a valid session terminates all existing ones for security reasons. Opening a share link is exactly such an access, so every **login** throws every other playback out of the box. Hence one remembered session per box, not one per share. What follows from it:

- Two FRITZ!NAS playlists **at the same time on two Echos** do not work — the second would cut off the first. One after another works with any number of shares.
- **Importing while something is playing** cuts that playback off — an import always logs in. The skill recovers: `PlaybackFailed` notices the dead number, fetches a new one and resumes the same track where it broke off.
- Someone working in the FRITZ!NAS web interface at the same time has the same effect.

**Asking beats logging in, and that distinction is the fix for a playback error mid-album.** An expired cache window used to mean a login, and a login terminates every session on the box — including the one the Echo is streaming with right now. With tracks of four or five minutes and a five-minute window, the window fell inside a running track almost every time: the Echo lost the file mid-play and reported `MEDIA_ERROR_INTERNAL_SERVER_ERROR — Device playback error`, and the skill skipped to the next track. So there is a cheaper step in front of the login now: a single `data.lua` call with the remembered number, which terminates nothing and, as an active access, extends the session at the box. While a playlist is playing that call always succeeds — the Echo has been keeping the session alive with every range request — so the session now carries a whole album, and a login only happens when the number is genuinely dead (box restarted, another share opened, the web interface used). When that does happen on a failed track, the track is **retried** at the point it broke off instead of being skipped: the file was fine, only its address was not. It retries exactly once — on the next failure the check says "still valid", no new number is fetched, and the skill moves on as before.

**A start does not trust the window either.** A silent start was reported where the log held three lines and ended with `musik-box IntentRequest in 34 ms` — no login (about 1550 ms), no check (about 640 ms), because the remembered number was less than a minute old and the five-minute window said so. But the window measures time, and on this box a session dies of events, not of time: a login for the second share, an import, someone in the FRITZ!NAS web interface. While a playlist is playing that hardly matters — the Echo keeps the session alive with every range request, and a bad guess costs one track. Before the first note nobody keeps it alive, and a bad guess costs the whole answer: *"Ich spiele …"*, then silence. So *"spiele …"*, *"weiter"*, *"von vorn"* and the play button check first; *"nächster Titel"*, shuffling and the queueing at the end of a track do not, because they happen inside a running playback.

**And the session was never the whole story: the disk has to be awake too.** Reported after all of the above was in place — the first attempt after a longer break stays silent, the second plays. The two logs differ only in how the number was obtained:

```
musik-box FRITZ!NAS-Login ok nach 2039 ms, 4338 ms Budget uebrig
musik-box spielt Das doppelte Lottchen … ab 1/9 bei 2808 ms: …456/nas/cgi-bin/luacgi_notimeout sid…95f3

musik-box FRITZ!NAS-Sitzung nachgefragt: gilt noch nach 946 ms, 5527 ms Budget uebrig
musik-box spielt Das doppelte Lottchen … ab 1/9 bei 2808 ms: …456/nas/cgi-bin/luacgi_notimeout sid…95f3
```

Same number, same address, same offset — the second attempt was handed byte for byte what the first was handed, so nothing about the skill's answer explains the difference. What the first attempt changed is the storage: `check_nas_rights` is answered from the box's head and never touches a file, and a disk on a FRITZ!Box spins down after a few minutes of quiet. The first fetch after that waits for it to spin up, which is exactly the wait the Echo will not sit through. The Echo's failed attempt woke the disk, and the second attempt found it turning.

So **before the first note the skill fetches one byte of the track itself** — a `Range: bytes=0-0` on the very address that is about to go into the directive. It is capped at 2.5 s and aborted after that; it does not have to finish, it only has to arrive, because the spin-up happens in the box and not in that connection. Aborting before the answer goes out also matters: two simultaneous fetches on `luacgi_notimeout` are a lot for that hardware, and the second one would be the Echo's. It runs on the three ways a playback *starts* — *"spiele …"*, *"weiter"* / the play button, *"von vorn"* — and never at a track change, where the disk is turning anyway.

**A timeout there is not a No either.** It is the normal answer from a disk that is spinning up, and it is the whole reason the wake-up call exists: refusing on it would refuse precisely when it just helped. Only an answer that is not audio — an error, a redirect to the login page, the FRITZ!NAS interface in HTML — stops the start, because the Echo would get the same thing a second later. The line `musik-box Datei angetippt: HTTP 206, audio/mpeg nach 140 ms` is also the counter-check for the diagnosis above: if it says the file was there and the Echo still stays silent, it was not the disk, and the next search starts at the device instead of at the box again.

**And the counter-check said it was not the disk.** The very line that was added for it answered on the next cold attempt:

```
musik-box FRITZ!NAS-Login ok nach 1951 ms, 4426 ms Budget uebrig
musik-box Geraet kann: AudioPlayer
musik-box spielt Das doppelte Lottchen … ab 1/9 bei 0 ms: … sid…f154
musik-box Datei angetippt: HTTP 206, audio/mpeg nach 613 ms, 3798 ms Budget uebrig
musik-box IntentRequest in 2705 ms
```

Session valid, file fetched in 613 ms, device reports `AudioPlayer` — and then not one AudioPlayer event. No `PlaybackStarted`, no `PlaybackFailed`. A device that tried and failed reports back; this one never saw the directive. So the wake-up call stays (it costs half a second and rules the disk out for good), but the cause is elsewhere: see **the budget starts at Alexa** below.

**What was left after everything else had been excluded: the box, in the seconds after a login.** The measurements, one by one:

| Observation | What it rules out |
|---|---|
| `Alexa wartet seit 3683 ms` of a 8000 ms window | the answer being late |
| Alexa speaks *"Ich spiele Das doppelte Lottchen."* | the answer being rejected |
| `Geraet kann: AudioPlayer` | the device lacking the interface |
| the same Echo, after the same long pause, plays a **non-FRITZ!NAS** playlist first time, every time | the device being asleep |
| `Datei angetippt: HTTP 206, audio/mpeg nach 668 ms` | the file, the path, the session number |
| a minute later the **same address with the same number** plays | the address, the offset, the token |

What every silent attempt has in common, and no playing one does, is the **login**. `filelink.lua` without a session terminates all sessions on the box, per AVM's own technical note. The skill's own probe, 668 ms later, still gets through; the Echo's fetch, a second or two after that, does not; a minute later the same number works again. What the box does in between is not visible from outside — that it is not fit to serve a second client during it is established by elimination.

So after a login the skill **spends what is left of its budget before answering, and probes the file a second time**. One change, two effects: the Echo's fetch moves away from the login, and the second line in the log says whether the box is still serving at that later moment — the observation about the box that was missing all along. Without a login none of it happens: there is no problem there, and two seconds of silence before every track would be a high price for nothing.

**The first attempt at this gap contained the same class of mistake twice: arithmetic without slack.** Two constants meant the same thing and were different sizes — the pause held back 600 ms, the fetch after it demanded 900 — so the second probe could never happen in a tight budget, which is exactly where it was needed. The log said so, and it took a reported case to read it:

```
musik-box Datei angetippt: HTTP 206, audio/mpeg nach 644 ms, 2258 ms Budget uebrig
musik-box Weckruf ausgelassen, nur noch 1300 ms Budget
```

`2258 − (2258 − 700 − 600) = 1300`. And once that was fixed, the pause landed two milliseconds short, because `setTimeout` never sleeps for exactly as long as it is told. The reserve behind the pause is also deliberately smaller than `SID_ANTWORT_RESERVE_MS`: those 700 ms protect against a network call overrunning, and after the second probe there is no call left, only `res.json()` — while the outer budget already holds a second and a half back. Taking that reserve twice halved the pause.

**The 1.5 seconds are a bet, not a measurement**, so they live in an environment variable (`MUSIK_WECK_ABSTAND_MS`) rather than in the code: if the box needs longer, that is a number in Vercel's dashboard and not a deploy; `0` switches the whole second round off. And if the second probe comes back with the FRITZ!NAS interface instead of audio, nothing is promised — the Echo would get the same thing.

**A redirect is not silence.** The line that says why the box said nothing paid for itself the first time it ran:

```
musik-box FRITZ!NAS-Sitzung nachgefragt: ohne Antwort (HTTP 303) nach 753 ms
```

An `HTTP 303` on `data.lua` is the box saying *"I do not know this number, go to the login"* — a No, not a shrug. Booked as "cannot be determined", the skill could go on to start playback with it while its own window was still running, and the Echo got the login page instead of the file: precisely the reported *"Ich spiele …"*, then silence. So any answer below 500 now counts as a rejection — a redirect, an error status, or the FRITZ!NAS interface as HTML with status 200. A **5xx stays undetermined**: there the box is overloaded or broken, which says nothing about the number, and declaring it dead would mean logging in during a running playback — which ends every session on the box. The protection that "silence is not a No" was built for stays exactly where it was meant to be.

**And the queue is cleared before a start.** `AudioPlayer.ClearQueue` with `CLEAR_ALL` goes out ahead of the `Play` directive, the usual remedy in reports of an Echo that sits silently on an old queue. `REPLACE_ALL` replaces the queue anyway; this says it explicitly.

**The theory behind it is weak, and that belongs here.** It is measured that the same Echo, after the same long pause, plays a playlist from a different server on the first attempt — a stuck queue would have been just as much in the way there. It costs nothing and breaks nothing, but it probably does not fix what stays silent here. So it sits behind a switch: `MUSIK_CLEAR_QUEUE=0` takes it out again, without a deploy. Only before a **start**, never at a track change: the next track is appended with `ENQUEUE`, and an emptied queue in front of that would clear away exactly what is being built.

**It is not Alexa's window that decides, but a much tighter one.** Alexa accepted every answer and spoke the sentence; whether the Echo then *executes* the `Play` directive turned out to be a different question. Measured on an Echo that had been idle for a while:

```
silent:  3683, 3846, 4537, 5204, 5771 ms   — and not one AudioPlayer event after it
plays:   1868, 2524 ms                     — PlaybackStarted after 18 ms
```

On the silent side the device did not even try: no `PlaybackStarted`, no `PlaybackFailed`, nothing. On the playing side it reported back in 18 milliseconds. Everything else about the two answers is identical, down to the session number and the byte the box serves. What differs is the time.

So the skill now has a **haste target** of about 2.5 s, counted from Alexa's own timestamp, and everything dispensable gives way to it:

- **The wake-up call is skipped** once the target is spent. It was built for the disk theory, and that is disproven — eight probes out of eight came back `HTTP 206` with audio. What is left of it is half a second on exactly the path where half a second decides between sound and silence.
- **The check before a login is skipped** when the remembered number is past its window anyway. It costs about 740 ms and has exactly one job: to avoid a login that throws a **running** track out of the box. Before the first note nothing is running that it could protect.

Both only before a start. At a track change nobody is waiting for a spoken sentence, the Echo appends the next track itself, and there the check is worth its 740 ms precisely because it prevents that login. `MUSIK_EILZIEL_MS` moves the target without a deploy; `0` switches the haste off and restores the earlier behaviour.

**And before a start the login goes without its counter-check.** Two trips to the box — fetching the scaffold and verifying the number — cost between 1443 and 2635 ms measured, which before the first note is the single largest item there is. The verification is the more dispensable half: `sidKandidaten` puts the explicit `sid=` values first, and those come from the answer the box gave to *this very* login, so it is the likeliest candidate rather than a guess. And a mistake carries itself: if the number is wrong after all, the Echo gets the login page, reports `PlaybackFailed`, and that request has a fresh eight seconds and a warm function — the session is checked under duress and the same track retried. The same path that already caught a `MEDIA_ERROR_SERVICE_UNAVAILABLE` in practice, with `PlaybackStarted` 18 ms after the second attempt.

In practice that means *always*, before a start: even the fastest login measured leaves no room for another trip to the box once the lead time is counted. During playback the counter-check stays — no haste target reaches there — and `MUSIK_EILZIEL_MS=0` keeps it everywhere.

**Silence from the box is not a No.** The check has three outcomes, and the difference matters: on a No the skill logs in, on no answer at all it does not — whoever cannot be reached will not accept a login either, and then the remembered number, still inside its window, is the best word there is. The same applies when the remaining budget is too small for a check: the window keeps its say. Staying silent while the number is very probably fine would be the worse choice.

**Only a request that is about to hand out an address refreshes at all.** Reported from a log holding exactly two lines — a login of 1572 ms, then `IntentRequest in 1603 ms`, with no `Geraet kann` and no `spielt` between them. An intent that plays nothing: a misheard sentence, a question back, a stop. And a **login** all the same, which per AVM ends every session on the box — while the Echo was streaming. That is precisely the damage the check in front of the login was built to prevent, on a path nobody had looked at: the refresh ran for *every* request, because `gemeintePlaylist` falls back to the running stream when there is no slot. Listing the playlists, the help, *"das habe ich nicht verstanden"*, stop, and the events at the end of a track now leave the session alone. For intents the list is the same one that decides whether a device without `AudioPlayer` hears a sentence instead of a promise — both questions mean the same thing: *is music about to come out of this?*

Only the playlist this request is about gets refreshed — fetching a number costs two calls to the box, and Alexa allows the skill eight seconds. The number is cached in Redis for five minutes — AVM grants ten, extended by every active access. A track the Echo failed to load overtakes that window: `PlaybackFailed` re-checks the number immediately rather than sitting the window out, because an expired one is by far the likeliest cause and the next track would carry the same. If the box cannot be reached at all, the skill says so instead of starting: the remembered number is past its window by then, and playing with it produced exactly the failure that was reported — *"Ich spiele das doppelte Lottchen"*, then silence, every first attempt. A sentence that explains beats a promise that does not hold.

**With exactly one exception: there was no time to ask.** After a cold start the budget is down to its floor, and neither the check nor the login fits into it — so the box is not touched at all in that request. What exists then is not bad news about the remembered number, it is *no* news. "Past its window" only means *older than five minutes*, and the box extends a session on every access, so the number is quite probably still good. The skill therefore starts with it, and the failure carries itself: if the Echo cannot fetch the file it reports `PlaybackFailed`, and that is a **fresh request with a full eight seconds and a warm function**, where the session is checked under duress and the same track is retried. *"Versuch es gleich noch einmal"* turns into a delay of a second or two — and in the good case into none at all. Once the box has answered, though — with a no, or not at all — the sentence stands: that is exactly where betting on the old number was tried before and produced nothing but silence. The log says which of the two happened (`FRITZ!NAS-Sitzung ungeprueft (keine Zeit zu fragen)` versus `FRITZ!NAS-Sitzung fehlt`).

The card in the dashboard marks such a playlist with **FRITZ!NAS**; clicking that reveals which folder it came from (`/Musik/Schlaflieder`), as a link that opens the share itself in a new tab, and *Edit* puts the share link back into the *Import folder* field, so it can be looked up, copied or replaced. Changing that field alone does not change the playlist — the link is only taken over by pressing *Import folder*, and saving with an unapplied one says so instead of quietly keeping the old.

**Everything outside the skill runs without a deadline, and that used to mean without a cache.** *Check URLs* and the import have no Alexa window, so they pass `Infinity` as the remaining budget. `setTimeout` turns that into **one millisecond** — it warns once with `TimeoutOverflowWarning` and then loses every race against a real Upstash call. The remembered session number therefore counted as absent (`musik_fritz_sid nicht rechtzeitig: nach Infinity ms`), and *Check URLs* logged in every single time: precisely the access that terminates every session on the box. Pressing it during playback threw out the track it was meant to be checking. A deadline of `Infinity` now simply means no timer at all.

**Check URLs** uses the same refresh, so it tests what the Echo would actually be handed rather than the stored address: without that it reported every FRITZ!NAS playlist as broken while it was playing perfectly — and a check nobody believes is worse than none. It says so in its first line when it did. It also slows down for a FRITZ!Box: one request at a time instead of four, seven seconds instead of four, and six tracks per call instead of twenty. A box serves each track through a Lua script from its own storage over a household uplink, and four at once means none of them answers in time.

- **When the import finds nothing, it hands back the page it fetched**: an expandable *Page source* block below the field, with the page title, the scripts it loads and its source (in full if it is small, otherwise both ends of it), plus a copy button. That is the fastest way to tell apart a link pointing at the wrong place, a login in the way, and a list the browser builds — without digging through the browser's developer tools. It appears only when nothing was found, and only behind `ADMIN_PASSWORD` like the rest.
- The import runs behind `ADMIN_PASSWORD` like everything else under `/api/manage`, refuses anything but `https://`, and rejects hosts that resolve to a private or loopback address, so it cannot be used as a probe into the Vercel network.

##### 9.3 Dashboard

- Open the dashboard → **Playlists** → enter a **speech-ready name** (this is what you say: `Kinderlieder`, `Hörspiele`) and the **URLs, one per line**. Optionally add a display title after a pipe: `https://…/01.mp3 | Hallo Welt` — it appears on Echo Show and in the Alexa app; otherwise the file name is used.
- **Repeat** decides what happens after the last track: on, the playlist starts over; off, it ends.
- **Announce** decides whether Alexa says *"Ich spiele Kinderlieder."* before the music. Off is for playlists that start as part of a routine, where a voice in front of the music is in the way. Follow-up questions and error messages are unaffected — a playlist Alexa cannot find still says so.
- **Shuffle** plays the tracks in a random order, reshuffled at the start of every round so a long session does not repeat the same sequence. The order is derived from a number in the stream token, so nothing extra is stored and *"nächster Titel"* still walks the shuffled order.
- **Resume** picks up where the playlist last stopped, and it has **two gaits**, because a record and an audiobook want different things. It works across days and across Echo devices, and the position is kept per playlist, not per person: whoever carries on in the kids' room continues where the living room left off, which is what a household wants and what a public skill would call a flaw. A finished playlist and *"von vorn"* both clear the mark.
  - **Album** remembers the *track* and replays it from its beginning. Stop during track 5 and the next start plays track 5 whole. A record is a sequence of finished pieces; half a song is not a place anyone wants to land in.
  - **Audiobook** remembers the *second*. Stop thirty seconds into a three-minute chapter and the next start resumes at 0:25 — five seconds behind the mark (`MUSIK_VORLAUF_MS`), because whoever stops in mid-sentence wants the sentence, not its second half. That rewind settles the other edge too: stop after four seconds and the track starts over instead of skipping them.
  - **Off** is the third setting and the default. The playlist then always begins at the first track.
  - **The second is recorded either way**, even on *Album* — it costs nothing, and switching a playlist to *Audiobook* later finds a usable mark already there instead of waiting for the next stop.
  - **A stop always lands on the track that is playing**, in both gaits. The mark moves on when the next track actually starts (`PlaybackStarted`), and a finished playlist is noted when its last track has really played out (`PlaybackFinished`). What does *not* move it is Alexa's request for the next track (`PlaybackNearlyFinished`): despite the name she sends it as soon as her queue has room, usually seconds after a track begins, not shortly before it ends. Moving the mark there used to make *Album* replay the *following* song instead of the stopped one, for the whole length of a track.
  - **A short pause is always to the second**, in both gaits: *"Alexa, Pause"* and *"weiter"* continue in the same spot. The gait is about taking a playlist up again later, not about pausing — whoever presses pause does not want half the song again.
  - **Playlists that existed before this setting have it off.** If *Resume* seems not to work, that is the first thing to check: dashboard → edit the playlist → *Resume* → *Save Playlist*.
- **Repeat and Announce are on** for new playlists, **Shuffle is off and Resume is Off** — in each case the way the skill behaved before that setting existed, so playlists created earlier keep their old behaviour untouched.
- **Save** upserts by name (case-insensitive). **Edit** loads a playlist back into the form, **Check URLs** tests every link, the trash icon deletes.
- The **arrows** move a playlist up or down, and **Sort A–Z** puts the whole list in alphabetical order once (umlauts sort as their base letter, not behind Z). The order is stored, not just displayed — it is also the order Alexa reads out when she asks which playlist to play, so the bedtime list does not have to come last. A–Z is an action rather than a view setting, so moving a single entry afterwards still works.
- Blank lines are ignored; anything that is not an `https://` URL is rejected with its line number. Up to 200 tracks per playlist.

Everything goes through `/api/manage?type=playlists` (`GET`, `POST {name, urls, wiederholen, ansage, zufall, fortsetzen}` — `fortsetzen` is `"aus"`, `"titel"` or `"sekunde"` rather than a switch, and a stored `true` from before the two gaits still reads as `"sekunde"` —, `DELETE {name}`, `GET &pruefen=1&name=…` for the check, `GET &import=1&url=…` for the folder import, `POST &sortieren=1 {namen: […]}` for the order), protected by `ADMIN_PASSWORD` like the rest of the dashboard. Leaving a switch out of a `POST` keeps its stored value, so a script that only fixes a track list cannot flip one by omission; switching it off has to arrive as an explicit `false` — so it can be scripted from a workflow just like persons and zones (8.5).

##### 9.4 Alexa Custom Skill

1. [Alexa Developer Console](https://developer.amazon.com/alexa/console/ask) → **Create Skill** → name `Meine Plattenkiste`, locale **German (DE)**, type of experience **Other**, model **Custom**, hosting **Provision your own**, template **Start from Scratch**.
2. **Invocation name**: `meine plattenkiste` (lower case, three words). Avoid anything containing *musik*: an invocation name [must not overlap with Alexa's own functions](https://developer.amazon.com/en-US/docs/alexa/custom-skills/choose-the-invocation-name-for-a-custom-skill.html), and `musik box` kept landing in Amazon Music instead of the skill.
3. **Interfaces** → enable **Audio Player** and **Playback Controller** → *Save Interfaces*. (Pause/Resume become mandatory intents once AudioPlayer is on — the model below already contains them.)
4. **Interaction Model → JSON Editor** → paste [`alexa/interaction-model-musik.de-DE.json`](alexa/interaction-model-musik.de-DE.json) → **Save Model** → **Build Model**. Run `node alexa/pruefe-modell.mjs alexa/interaction-model-musik.de-DE.json lib/musik.js PLAYLIST_NAME` first — the same check the CI runs.
5. **Endpoint** → **HTTPS** → Default region: `https://your-app.vercel.app/api/skill` (**the same URL as the familien finder skill**) → SSL certificate type: *"My development endpoint is a sub-domain of a domain that has a wildcard certificate from a certificate authority"* → *Save Endpoints*.
6. Copy the **Skill ID** into the `MUSIK_SKILL_ID` environment variable in Vercel and redeploy. Until then the endpoint answers `401` and Alexa says there was a problem with the skill's response.
7. **Test** tab → *Development* → type `öffne meine plattenkiste` — Alexa asks which playlist and lists the ones from the dashboard — then `spiele kinderlieder`. The simulator does not play audio but shows the `AudioPlayer.Play` directive with the stream URL on the right. Then on an Echo: *"Alexa, öffne meine plattenkiste und spiele Kinderlieder."*

Development mode is enough: the skill works on every Echo of your Amazon account without certification or publishing.

**Playlist names need no model changes.** A new playlist goes into the dashboard and nothing else — the one-shot call (*"öffne meine plattenkiste und spiele Taschenlampe"*) reaches an `AMAZON.SearchQuery` slot, which takes free text and so recognises any name.

That takes two intents, because a `SearchQuery` sample may not consist of the slot alone and always needs a carrier word in front of it — which is exactly what answering the skill's own question requires. So `SuchePlaylistIntent` (free text, always with a carrier word) handles the one-shot call, and `PlayPlaylistIntent` (the `PLAYLIST_NAME` slot, sample `{playlist}`) handles *"Welche Playlist?"* → *"Taschenlampe"*. Both end up in the same handler.

Three phrasings had to go for this, since the slot must sit at the end: *"Taschenlampe abspielen"*, *"Taschenlampe zu spielen"* and *"ich möchte Taschenlampe hören"*. The skill is forgiving with the rest: *"spiele Kinder"* starts *Kinderlieder*, and filler words do not matter.

**A number word and a digit are the same name.** `AMAZON.SearchQuery` has no entity resolution — only the transcribed text arrives — and whether speech recognition writes *"eins"* or *"1"* varies from one call to the next. *"Udo CD 1"* against a playlist called *Udo CD eins* matched nothing: not as a whole, not as a prefix, not as a part. The skill answered *"Ich habe keine Playlist namens Udo CD 1 gefunden"* and no music played — intermittently, and only for the one-shot call, because the two-step one carries the playlist names along as dynamic entities and lets Alexa resolve against them. Comparison now folds *null* through *zwanzig* (and *zwo*) to digits, on both sides, so either spelling finds either name. Whole words only: otherwise *Kleinstadt* would become *kl1tadt*.

**Every start attempt leaves a line**, whether or not the playlist announces itself: `musik-box spielt Udo CD eins (gehoert: "Udo CD 1") ab 1/24: …`, and a name that matched nothing says so with what it was compared against. Without those, a failed match and a silent box look identical from the outside.

**Not every Alexa device can play it.** Long-form audio needs the `AudioPlayer` interface, and a device that does not offer it drops the `Play` directive silently — the skill's sentence is all that is left, promising music that never arrives. That was the report from a Fire TV: *"Ich spiele Udo CD eins weiter"*, then nothing. Every request says what its device can do (`supportedInterfaces`), so the skill reads it there rather than keeping a list of device types that would go stale with each Amazon generation, and answers with a sentence that explains. **A device that says nothing about itself still gets its music** — the fallback is the previous behaviour, and only an explicit list without `AudioPlayer` is turned away. Reading the list, announcing the playlists, help, pause and stop work everywhere and are not gated.

**Afterwards:** *"Alexa, weiter"* works even when the Echo has forgotten the stream — after the radio in between, or the next day. Without a running stream the skill falls back on the newest resume mark and carries on with the playlist that was stopped last. Only playlists with *Resume* set leave such a mark, and it is taken up in that playlist's gait.

**While playing:** *"Alexa, nächster Titel"*, *"voriger Titel"*, *"Pause"*, *"weiter"*, *"von vorn"* and *"Stopp"* work as usual, as do the buttons on Echo Show and in the Alexa app. *"Zufallswiedergabe an"* and *"aus"* reshuffle the running playback without touching the stored playlist — the order lives in the token, so the change reaches exactly this one stream. Asking Alexa to repeat, on the other hand, only reports how the running playlist is set and points at the dashboard: flipping that one by voice would change the playlist for good and for everyone. A track that fails to load is **retried once**, picking up where it broke off, and only skipped if it fails again. If every track of a round fails, playback stops instead of circling forever.

**With Repeat off**, nothing is queued behind the last track, so it plays to its end and the playlist stops — a `Stop` at that moment would cut the last track off mid-song. *"Nächster Titel"* on the last track ends playback; *"voriger Titel"* on the first one replays it rather than jumping to the end.

**Alexa routine** (optional): *Mehr → Routinen → +* → *Wenn: Sprache* `musik an` → *Aktion: Angepasst → Skills → Meine Plattenkiste*. A routine cannot pass a parameter, so it opens the skill and Alexa asks which playlist.

##### Not every Alexa device reports back

A Fire TV plays a one-track playlist and never sends a single `AudioPlayer` event — no `PlaybackStarted`, no `PlaybackFailed`, no `PlaybackStopped`. The skill's own request log shows the `IntentRequest` and nothing after it, on a call that audibly worked. Everything the skill builds on those events is therefore inert there:

- **The next track is never queued.** `PlaybackNearlyFinished` is what appends it, so a playlist plays its first track and stops.
- **A failed track is never retried**, and a dead session number is never noticed — the recovery above never runs.
- **No resume mark is written**, because that happens on `PlaybackStarted`, `PlaybackStopped` and `PlaybackFinished`.

None of this is fixable from the skill: a device that does not report cannot be answered. Long-form audio playlists belong on an Echo. The log is the only way to see it — a device that plays without leaving a `PlaybackStarted` line behind is one of these.

**And the same Fire TV plays nothing at all from a FRITZ!NAS folder share.** Measured, not guessed: a playlist whose addresses are `filelink.lua?id=…` file shares plays; both playlists on `…/nas/cgi-bin/luacgi_notimeout?…&sid=…` folder shares stay silent, on the same host and port, with a session number checked live moments earlier. Switching the announcement off makes the two responses structurally identical — same `shouldEndSession`, same `playBehavior`, same directive, differing only in the stream address — so nothing about the skill's answer explains it. What the device does with that address, whether it even fetches it, and what the box replies are all invisible, because the device reports nothing back.

So for a Fire TV the practical rule is: **file shares play, folder shares do not**, and even a file share gets one track and then stops. Four hypotheses were spent before that was clear — the device's own interfaces, a resume offset mid-file, speech alongside the directive, and `+` versus `%20` in the query. Each was ruled out by a measurement, and the log lines added along the way are what remains of them.

##### Spaces in the address are `%20`, not `+`

`URLSearchParams` writes a space as `+`, which is what the form-encoded format wants, and the FRITZ!Box reads it correctly — an Echo plays such an address without complaint. Another player need not. `+` only means "space" in that one format; in an address it is an ordinary character, and a client that reassembles the query by its own rules turns it into `%2B` and then looks for a file called `01.+Die+Buehne.mp3`. `%20` means the same thing in both readings and decodes to the identical path, so it is the narrower choice and costs nothing.

`mitSid` used to undo this. Its comment claimed it left everything but the session number alone; in fact `searchParams.set` marks the query dirty and `href` reassembles all of it, so the import's `%20` came back out as `+` on every play. The reassembly itself is lossless — only the spelling of the spaces is straightened afterwards, so both paths produce the same address.

##### One retry, and only one

A track the Echo could not load is played again before the skill moves on. The reason is in the log of the case that prompted it: session number checked valid seconds earlier, `Offset: 1` — the track had never started — and *Check URLs* reported the whole playlist green. The files were fine and the session was fine, so what is left is the box. It serves every file through a Lua script, and at a track change the Echo starts fetching the next one while the current is still streaming. Two fetches at once is a lot for that hardware — the same narrowness that made *Check URLs* drop to one request at a time for a FRITZ!Box. A failure that comes from load is gone on the next attempt, and skipping the track punishes the listener for one bad second of the box's.

**And it takes a breath first.** Reported with the retry already in place: `MEDIA_ERROR_INTERNAL_SERVER_ERROR`, `Offset: 1`, track 4 of an album, the session checked seconds earlier and valid — and afterwards the music did not come back at all. Session and file were fine; what was missing was air. The retry went out immediately and therefore hit the same overloaded box, the next track after it did too, and so on until the round was through and playback ended. Both the retry and the step to the next track now probe the file first: half a second of distance, and a line in the log saying whether the box is serving *now*. It plays either way — what is measured there is a second old, and skipping the track over it would be worse than trying it.

The retry resumes where the track broke off, minus the usual pre-roll: at the start in the ordinary "never got going" case, and at the exact spot if the session died mid-stream.

**The budget lives in the token** (`playlist|position|round|seed|attempt`), for the same reason everything else does: it belongs to this one stream, Alexa sends it back with every event, and it disappears with the track. A retried stream carries a `1`, a failure on a `1` is allowed to skip, and the next track starts at `0` again. A zero is left out of the token entirely, so a stream where nothing went wrong looks exactly as it did before — which keeps every stream that is running during a deployment valid.

The failure line names the track, not just the position: `Titel: 12. 12 Ich war noch niemals in New York – …luacgi_notimeout sid…fe7f`. With shuffle on, position 23 is not track 24, and without the number there is nothing to look up in the dashboard; the address shows which session number the failed fetch actually carried. Both cost several rounds of a debugging session before they were added.

##### One long file is not one long track

A session number for the FRITZ!NAS lasts about ten minutes, extended by active
use — and the skill's own check between tracks counts as use, so an ordinary
playlist keeps its session alive by playing. A three-minute song is done long
before the ten minutes are up. **An hour-long audio play is not**: the Echo
pulls it in ranges across that whole hour, every range carrying the same
number, and nothing guarantees it survives. Any *login* elsewhere ends *all*
sessions on the box as well, so an import, a second share or the FRITZ!NAS web
interface can still pull the ground out from under a running one.

*Check URLs* therefore reports the size, the bit rate and the playing time of
every track, and marks with ⏳ whatever plays longer than a session lasts.

**The playing time is read, not guessed.** It used to be estimated from the file
size at an assumed 128 kbit/s, and for a chapter encoded at 320 that was off by
a factor of two and a half: 14 MB was reported as a quarter of an hour and is in
fact just under six minutes. A number that wrong is worse than none, because
people act on it. The check now reads the first 32 KB of the file — the MPEG
header there carries the real bit rate, and a variable-rate file carries its
frame count in the same place, which gives the duration exactly. Only where that
fails (not an MP3, an unreadable header) does the old estimate appear, and then
with a `~` in front of it. The import says the same thing at the moment it
matters most, while the playlist is being created.

The remedy is not in the skill — the Echo does the loading and the box forgets
the number underneath it. **Split long recordings into chapters.** *Resume* set
to *Audiobook* is to the second either way, but a chapter is also what the Echo
can still load when the evening is over — and on *Album* a chapter is the unit
that gets replayed.

##### Why the skill never goes silent

Alexa gives a skill about **eight seconds**, then gives up — and the person
hears *nothing at all*, which is the worst of all answers because no one can
tell whether anyone was listening. Two mechanisms keep the skill inside that
window, and both exist because it once did not.

**Every answer that keeps the session open carries a reprompt.** Without one,
Alexa closes the session after a few seconds *without saying so*: the
microphone shuts, and the next sentence no longer reaches the skill. Anyone who
hesitates for a moment after *"Welche Playlist soll ich spielen?"* used to talk
into a closed line, try again faster, and see it work the second time. The
reprompt is deliberately shorter than the first question — whoever just heard
the names does not need them again.

**And every answer that finishes a command closes it.** The counterpart, and it
was missing for just as long. A response without `shouldEndSession` does not
mean *end it* to Alexa but *leave it as it is* — and after the two-step call
(*"öffne meine Plattenkiste"*, then *"spiele Kinderlieder"*) it is open. The
answers to pause, next, previous, start over and shuffle carry no speech, only
a directive, so they looked harmless; in fact the Echo kept listening after
every finished command, as if it expected more. Now those answers end the
session, which is allowed next to a Play directive — only `false` would not be.
Events from the AudioPlayer and the buttons in the Alexa app still omit the
field, because there is no session there to end.

**The skill no longer promises what it cannot keep.** If no session number can
be fetched, the stored addresses still carry the one from import time, which is
almost certainly dead — the box answers such a request with its own web page,
and the Echo drops it without a word. Alexa used to say *"Ich spiele …"*
anyway. Now it says it cannot reach the box, and each start logs host, port and
the last four digits of the session number, never the whole one.

**Every request runs on a time budget** of 6.5 seconds, adjustable through
`MUSIK_BUDGET_MS` and re-read on every request. Database lookups that overrun it
fall back instead of waiting, and the skill says so rather than going quiet. The
biggest item on that budget is the **FRITZ!Box login**: the box is slow, its
session number is only kept for five minutes, and every longer pause forces a
fresh login.

**So the login happens when the skill is opened, not when a playlist is named.**
A call has two steps — *"öffne meine Plattenkiste"*, then *"spiele das doppelte
Lottchen"* — and the whole login used to sit in the second. That is the narrow
one: name lookup, saved position, directive and Alexa's eight seconds all share
a budget there. The first step reads a list and asks a question; its time lay
idle. Now the login falls into it, and the seconds the person spends answering
are enough for the second step to find the number ready. Should the login fail
there, the second step still has its own attempt, this time over warm
connections — one try became two. It only happens when there is exactly one
share link: every login ends all sessions on the box, and with several links
there would be nothing to go on but a guess, which would take the session from
the very playlist that was meant.

**The FRITZ!NAS login gets the time that is actually left.** It used to allow
itself a fixed four seconds. On a warm function that is plenty; on the first
call after a pause it is not, because name resolution and the TLS handshake to a
slow box come on top — the login ran into its own limit, the skill said *"Ich
komme gerade nicht an die FRITZ!Box"*, and only the second attempt worked. That
was the reported *"always starts on the second try"*. The login now receives the
remaining budget minus a reserve for the answer itself, roughly five and a half
seconds in the normal case, and the threshold below which it is skipped dropped
accordingly.

**The budget starts at Alexa, not at the skill's first statement.** This was
the blind spot behind every remaining *"only works on the second try"*. The
eight-second window belongs to Alexa and starts when she creates the request;
the skill's budget started counting at the first line of its own handler and
knew nothing of what came before — the trip to Frankfurt, the TLS handshake,
and above all the **cold start** of the function after a long pause. On a warm
function the two are nearly the same. On a cold one they are not: the skill
still reckoned with six and a half seconds it no longer had, let the login
(about two seconds) go ahead on that arithmetic, and its answer arrived after
Alexa had hung up. The second attempt found the function warm and the number
remembered, and everything worked — exactly the reported pattern, with nothing
wrong in the answer itself, only in when it arrived.

Every request carries Alexa's own timestamp (`api/skill.js` already reads it to
reject stale requests), so the distance to now is precisely that lead time. The
budget subtracts it. When a lot has been eaten, a floor of 1.2 s remains: no
login, no check, and instead of silence the sentence *"Ich komme gerade nicht an
die FRITZ!Box"* — which arrives, and leaves a line in the log saying why. Two
clocks never agree exactly, so a negative or absurd lead time is discarded and
the full window applies; a wrong budget would be worse than none.

Each request logs its own duration as `musik-box <type> in <n> ms`, and every
login logs `musik-box FRITZ!NAS-Login ok nach <n> ms, <n> ms Budget uebrig`.
Those two lines separate the skill's own work from the cold start, which the
Vercel timing alone cannot, and say whether the login was the reason. The step
in front of it logs too — `musik-box FRITZ!NAS-Sitzung nachgefragt: gilt noch`
or `… ist tot`, and when the box says nothing at all, **why** — `ohne Antwort
(nicht erreichbar)` rather than the bare `ohne Antwort` that once cost a round
of searching. So a log full of the first and empty of logins is what a
healthy album looks like, and a login between two tracks is now the thing worth
explaining. A starting playback adds a third line, `musik-box Datei angetippt:
HTTP 206, audio/mpeg nach <n> ms`: that is the track itself, fetched one byte
deep before anything is promised — see **the disk has to be awake too** above.
The duration line now carries the number that matters most: `musik-box
IntentRequest in 2705 ms, Alexa wartet seit 8123 ms (Vorlauf 5418 ms)`. Anything
over eight thousand there means Alexa had already hung up — the answer was not
wrong, it was late, and no other line in the log would ever have said so.

**The functions run in Frankfurt** (`"regions": ["fra1"]` in `vercel.json`).
Without that line Vercel places them in Virginia by default, and every request
crosses the Atlantic twice: once from Alexa's European endpoint, and again for
every database lookup. Keep the Upstash database in Europe as well — a function in
Frankfurt talking to a database in the US is worse than both being in the US.

| Symptom | Cause | Fix |
|---|---|---|
| "Es gab ein Problem mit der Antwort des Skills" | `MUSIK_SKILL_ID` missing or wrong → `401` | step 6, redeploy |
| Nothing at all happens after the second sentence | the session had already closed, or the answer arrived too late | should no longer occur — see **Why the skill never goes silent** below; check the `musik-box … ms` line in the Vercel logs |
| "Ich komme gerade nicht an deine Playlists" | Redis did not answer within the time budget | say it again; if it repeats, check Upstash |
| Alexa confirms, then silence — always on the first attempt, FRITZ!NAS | the login sat in the second step of the call and did not fit there; the Echo was handed an expired number | fixed: the session is fetched when the skill is opened — see **Why the skill never goes silent** |
| Alexa confirms, then silence — the first attempt after a longer break, FRITZ!NAS, and the second attempt plays the same address with the same session number | the box's disk had spun down; the first fetch waits for it to spin up and the Echo does not sit that out. The skill only ever touched the session, never a file | fixed: one byte of the track is fetched before the answer goes out, which wakes the disk. Look for `musik-box Datei angetippt: …` in the log |
| Silence on the first attempt although the log shows a valid session, a reachable file and `Geraet kann: AudioPlayer` — and **no** AudioPlayer event follows | **not** the cold start: measured at `Alexa wartet seit 3683 ms` of 8000, with Alexa speaking the sentence. What is left after elimination is the box in the seconds after a login | the skill now puts a gap between the login and its answer and probes the file a second time — see **the box, in the seconds after a login** above. Look for `Datei nach <n> ms Abstand noch einmal angetippt` |
| Silence on a Fire TV from a FRITZ!NAS **folder** share, while a **file** share plays | not the skill: with the announcement off, both responses are structurally identical and differ only in the stream address. The device fetches — or refuses — that address without reporting anything back | none. Use an Echo for those playlists; see **Not every Alexa device reports back** |
| Alexa confirms, then silence — on a Fire TV, a tablet, or anything that is not an Echo | the device does not offer the `AudioPlayer` interface, so it drops the `Play` directive without a word; only the sentence was left, and it promised something that never came | fixed: a device that does not report `AudioPlayer` now hears why instead of a promise. The log line `musik-box Geraet kann: …` lists what the device actually reported |
| Alexa confirms, then silence | URL is not a direct file, not https, or the certificate is invalid | **Check URLs** in the dashboard; the URL must play in a browser straight away |
| Alexa confirms, then silence — FRITZ!NAS, large file | the track plays longer than a session number lasts | **Check URLs** now shows ⏳ for those; split the file into chapters, see below |
| Playback stops when *Check URLs* or an import is pressed, FRITZ!NAS | *Check URLs* dropped the remembered session number (`musik_fritz_sid nicht rechtzeitig: nach Infinity ms`) and logged in, which terminates every session on the box | fixed: no deadline now means no timer, so the cache is read. An import still logs in — that is unavoidable, but the skill resumes the running track |
| `MEDIA_ERROR_INTERNAL_SERVER_ERROR – Device playback error` mid-album, FRITZ!NAS, and the track is skipped | two causes, both fixed: the skill logged in to the box while that very track was streaming (a login terminates every session on the box), and any failed track was skipped rather than retried | an expired cache window now asks whether the number still holds instead of logging in, and every failed track gets one retry — see **FRITZ!NAS folder shares** and **One retry, and only one**. Look for `musik-box FRITZ!NAS-Sitzung nachgefragt: gilt noch` in the log |
| "Ich komme gerade nicht an die FRITZ!Box" | no current session number, and the remembered one is past its window | the box was unreachable or slow; say it again. The skill no longer starts with a number it does not trust — see below |
| First track plays, then silence | `PlaybackNearlyFinished` got no `ENQUEUE` | Vercel logs of `/api/skill` |
| "Weiter" restarts the track | host without range support | **Check URLs** shows ⚠️ — pick another host |
| A playlist starts from the first track although it was stopped later | *Resume* is *Off* — it is off for new playlists and for every playlist created before the setting existed | dashboard → edit the playlist → *Resume* → *Save Playlist* |
| A track starts over instead of resuming at the second | *Resume* is set to *Album*, which is what that setting does | set it to *Audiobook* if you want the second |
| *Album* plays the **next** track instead of replaying the stopped one | fixed: `PlaybackNearlyFinished` pushed the resume mark to the queued track, and the Echo sends that event seconds after a track starts, not before it ends | the mark now follows `PlaybackStarted` and `PlaybackFinished` — see **Resume** in the dashboard section |
| *Import folder* finds nothing | the page builds its file list in the browser, or the link is not a folder share | the answer says which of the two it is; for a FRITZ!Box use the share link of the **folder**, not of the NAS web interface |
| Playlist not understood | new name, first sentence of the session | open the skill first, then say the name; or add the value to the model |
| Model build fails: `AMAZON.PauseIntent required` | AudioPlayer enabled, intent missing | use the JSON from the repo |

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
| *"Alexa, frag familien finder, ob [Name]s Handy klingeln kann"* | **Asks back first**, then makes the phone ring (Mylo app required) |
| *"Alexa, frag familien finder, lass [Name]s Handy aufhören"* | Stops sound, torch and announcement — no confirmation |
| *"Alexa, öffne meine plattenkiste und spiele [Playlist]"* | Plays the MP3 URLs of that playlist in order, repeating or stopping at the end as set (section 9) |
| *"Alexa, frag meine plattenkiste, welche playlists es gibt"* | Lists the playlists from the dashboard |

The Windows Agent supports **Sleep**, **Shutdown**, and **Hibernate** — configurable in the tray app.

---

### 🛡️ Security & Privacy

All communication between Vercel and your PC/VPS uses [ntfy.sh](https://ntfy.sh) with a unique, unguessable topic ID. This ID is derived from a **SHA-256 hash** of your MAC address + your private `ADMIN_PASSWORD`. No one can trigger your PC without knowing your secret password.

The VPS relay uses local TR-064 (HTTP, port 49000) over the WireGuard tunnel — no Fritz!Box external access is required or enabled.

The optional LED feature uses its own, fully separated chain: a dedicated ntfy.sh topic (`LED_TOPIC`) and password (`LED_PASSWORD`) taken directly from the environment variables (no hashing). The LED relay additionally ignores messages older than 60 seconds or with a wrong password.

The optional waste feature works the same way: its own topic (`ABFALL_TOPIC`) and password (`ABFALL_PASSWORD`), separate from LED and WoL, and a relay that ignores messages older than 60 seconds, with a wrong password, with an unknown action or with an already seen ID.

#### Endpoint protection

- **`/api/alexa` requires the bridge secret.** Every request must carry an `x-bridge-key` header matching `BRIDGE_KEY` (or `ADMIN_PASSWORD` as fallback), compared with `crypto.timingSafeEqual`. Alexa sends no signature to a Smart Home Lambda, so this is the only barrier — see step 3 for the setup. In addition, `endpointId` is validated against the configured devices, so the endpoint can no longer be used as an oracle to derive ntfy topics for arbitrary MAC addresses.
- **All key checks fail closed.** `/api/led`, `/api/location`, `/api/locations`, `/api/presence`, `/api/relay-status`, `/api/manage`, `/api/skill` and `/api/zones` reject the request when their environment variable is missing, instead of comparing `undefined` against `undefined` and letting it pass. `/api/skill` serves two skills and matches the incoming skill ID against `ALEXA_SKILL_ID` and `MUSIK_SKILL_ID` separately — an unset variable never matches.
- **The playlist URL check cannot be used as a probe.** `GET /api/manage?type=playlists&pruefen=1` fetches the stored URLs server-side (the dashboard's CSP forbids the browser to do it). It only follows `https://`, refuses hosts that resolve to private, loopback or link-local addresses, follows at most three redirects and gives up after four seconds per URL.
- **`/api/zones` is read-only and behind `LOCATION_KEY`, not `ADMIN_PASSWORD`.** The phones need the home zone to place their geofence, and they already carry that key to post positions; the admin password would additionally unlock device management and wake-on-LAN. Writing zones stays on `/api/manage`.
- **Brute-force protection** on `/api/manage`: after 10 failed attempts per IP the endpoint answers `429` for 15 minutes (counter kept in Redis).
- **Dashboard XSS protection:** every value coming back from the API is HTML-escaped before rendering, and delete buttons use event listeners instead of inline `onclick`. A `Content-Security-Policy` plus `X-Frame-Options`, `X-Content-Type-Options` and `Referrer-Policy` are set in `vercel.json`.
- **Account linking:** `/api/auth` only redirects to Amazon domains, so the endpoint cannot be abused as an open redirect.

> **Note:** `/api/token` still issues a static token — it is not the security boundary. Access control happens at `/api/alexa` via the bridge secret described above.

---

### 📜 License
Licensed under the MIT License. Developed with ❤️ by **FlowersPowerz**.

*If you like this project, please give it a ⭐!*
