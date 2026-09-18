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

Play your own MP3s on any Echo: a playlist is a **name plus a list of URLs**, managed in the dashboard. The Echo streams each file straight from its URL, so there is no media server, no NAS access and no VPS component — only the URLs have to be reachable from the internet. Two switches per playlist decide how it behaves. **Repeat** says what happens after the last track: start over and keep going until you say *"Alexa, Stopp"*, or end there. **Announce** says whether Alexa confirms with *"Ich spiele …"* before the first track, or the music simply starts.

**How it works:** the dashboard stores playlists in Redis (`musik_playlists`, plus `musik_stand` for the resume marks). A third Alexa skill (type **Custom**, with the **AudioPlayer** interface) reads them and answers every `PlayPlaylistIntent` with an `AudioPlayer.Play` directive. Shortly before a track ends Alexa asks the skill (`PlaybackNearlyFinished`) and gets the next track enqueued — after the last one, the first again. The state lives in the stream token (`<playlist>|<track>|<round>`), not in the database, so nothing can go stale.

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

**The box keeps one NAS session, and that shapes what is possible.** AVM's technical note on session IDs is explicit: the number of sessions is limited, a program should use only one per box — and an access *without* a valid session terminates all existing ones for security reasons. Opening a share link is exactly such an access, so every refresh throws every other playback out of the box. Hence one remembered session per box, not one per share. What follows from it:

- Two FRITZ!NAS playlists **at the same time on two Echos** do not work — the second would cut off the first. One after another works with any number of shares.
- **Importing while something is playing** cuts that playback off. It recovers on the next track (`PlaybackFailed` fetches a new session immediately), but the running track stops.
- Someone working in the FRITZ!NAS web interface at the same time has the same effect.

Only the playlist this request is about gets refreshed — fetching a number costs two calls to the box, and Alexa allows the skill eight seconds. The number is cached in Redis for five minutes — AVM grants ten, extended by every active access, and that extension is not a promise worth trading silence at the Echo for. A track the Echo failed to load overtakes that: `PlaybackFailed` fetches a fresh number immediately, because an expired one is by far the likeliest cause and the next track would carry the same. If the box cannot be reached at all, the remembered number is used anyway — it may well still be good, and a playlist with possibly dead addresses beats an answer with no tracks. The card in the dashboard marks such a playlist with **FRITZ!NAS**; clicking that reveals which folder it came from (`/Musik/Schlaflieder`), as a link that opens the share itself in a new tab, and *Edit* puts the share link back into the *Import folder* field, so it can be looked up, copied or replaced. Changing that field alone does not change the playlist — the link is only taken over by pressing *Import folder*, and saving with an unapplied one says so instead of quietly keeping the old.

**Check URLs** uses the same refresh, so it tests what the Echo would actually be handed rather than the stored address: without that it reported every FRITZ!NAS playlist as broken while it was playing perfectly — and a check nobody believes is worse than none. It says so in its first line when it did. It also slows down for a FRITZ!Box: one request at a time instead of four, seven seconds instead of four, and six tracks per call instead of twenty. A box serves each track through a Lua script from its own storage over a household uplink, and four at once means none of them answers in time.

- **When the import finds nothing, it hands back the page it fetched**: an expandable *Page source* block below the field, with the page title, the scripts it loads and its source (in full if it is small, otherwise both ends of it), plus a copy button. That is the fastest way to tell apart a link pointing at the wrong place, a login in the way, and a list the browser builds — without digging through the browser's developer tools. It appears only when nothing was found, and only behind `ADMIN_PASSWORD` like the rest.
- The import runs behind `ADMIN_PASSWORD` like everything else under `/api/manage`, refuses anything but `https://`, and rejects hosts that resolve to a private or loopback address, so it cannot be used as a probe into the Vercel network.

##### 9.3 Dashboard

- Open the dashboard → **Playlists** → enter a **speech-ready name** (this is what you say: `Kinderlieder`, `Hörspiele`) and the **URLs, one per line**. Optionally add a display title after a pipe: `https://…/01.mp3 | Hallo Welt` — it appears on Echo Show and in the Alexa app; otherwise the file name is used.
- **Repeat** decides what happens after the last track: on, the playlist starts over; off, it ends.
- **Announce** decides whether Alexa says *"Ich spiele Kinderlieder."* before the music. Off is for playlists that start as part of a routine, where a voice in front of the music is in the way. Follow-up questions and error messages are unaffected — a playlist Alexa cannot find still says so.
- **Shuffle** plays the tracks in a random order, reshuffled at the start of every round so a long session does not repeat the same sequence. The order is derived from a number in the stream token, so nothing extra is stored and *"nächster Titel"* still walks the shuffled order.
- **Resume** picks up where the playlist last stopped, across days and across Echo devices. Worth it for audiobooks, pointless for children's songs. The position is kept per playlist, not per person: whoever carries on in the kids' room continues where the living room left off, which is what a household wants and what a public skill would call a flaw. A finished playlist and *"von vorn"* both clear the mark.
- **Repeat and Announce are on** for new playlists, **Shuffle and Resume are off** — in each case the way the skill behaved before that switch existed, so playlists created earlier keep their old behaviour untouched.
- **Save** upserts by name (case-insensitive). **Edit** loads a playlist back into the form, **Check URLs** tests every link, the trash icon deletes.
- The **arrows** move a playlist up or down, and **Sort A–Z** puts the whole list in alphabetical order once (umlauts sort as their base letter, not behind Z). The order is stored, not just displayed — it is also the order Alexa reads out when she asks which playlist to play, so the bedtime list does not have to come last. A–Z is an action rather than a view setting, so moving a single entry afterwards still works.
- Blank lines are ignored; anything that is not an `https://` URL is rejected with its line number. Up to 200 tracks per playlist.

Everything goes through `/api/manage?type=playlists` (`GET`, `POST {name, urls, wiederholen, ansage, zufall, fortsetzen}`, `DELETE {name}`, `GET &pruefen=1&name=…` for the check, `GET &import=1&url=…` for the folder import, `POST &sortieren=1 {namen: […]}` for the order), protected by `ADMIN_PASSWORD` like the rest of the dashboard. Leaving a switch out of a `POST` keeps its stored value, so a script that only fixes a track list cannot flip one by omission; switching it off has to arrive as an explicit `false` — so it can be scripted from a workflow just like persons and zones (8.5).

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

**While playing:** *"Alexa, nächster Titel"*, *"voriger Titel"*, *"Pause"*, *"weiter"*, *"von vorn"* and *"Stopp"* work as usual, as do the buttons on Echo Show and in the Alexa app. *"Zufallswiedergabe an"* and *"aus"* reshuffle the running playback without touching the stored playlist — the order lives in the token, so the change reaches exactly this one stream. Asking Alexa to repeat, on the other hand, only reports how the running playlist is set and points at the dashboard: flipping that one by voice would change the playlist for good and for everyone. A track that fails to load is skipped; if every track of a round fails, playback stops instead of circling forever.

**With Repeat off**, nothing is queued behind the last track, so it plays to its end and the playlist stops — a `Stop` at that moment would cut the last track off mid-song. *"Nächster Titel"* on the last track ends playback; *"voriger Titel"* on the first one replays it rather than jumping to the end.

**Alexa routine** (optional): *Mehr → Routinen → +* → *Wenn: Sprache* `musik an` → *Aktion: Angepasst → Skills → Meine Plattenkiste*. A routine cannot pass a parameter, so it opens the skill and Alexa asks which playlist.

##### One long file is not one long track

A session number for the FRITZ!NAS lasts about ten minutes, extended by active
use. A three-minute song is done long before that. **An hour-long audio play is
not**: the Echo pulls it in ranges across that whole hour, every range carrying
the same number, and nothing guarantees it survives. Any refresh elsewhere ends
*all* sessions on the box as well, so a second playlist or a press of *Check
URLs* can pull the ground out from under a running one.

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
the number underneath it. **Split long recordings into chapters.** That also
makes *Resume* land somewhere sensible instead of in the middle of an hour.

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
session number is only kept for five minutes, and every longer pause used to
force a fresh login on the critical path. If the remaining budget no longer
covers one, the skill now plays with the remembered number instead. Should that
number be stale, the first track fails — and a failed track already triggers a
fresh login and carries on with the next one. Silence becomes a short delay.

**The FRITZ!NAS login gets the time that is actually left.** It used to allow
itself a fixed four seconds. On a warm function that is plenty; on the first
call after a pause it is not, because name resolution and the TLS handshake to a
slow box come on top — the login ran into its own limit, the skill said *"Ich
komme gerade nicht an die FRITZ!Box"*, and only the second attempt worked. That
was the reported *"always starts on the second try"*. The login now receives the
remaining budget minus a reserve for the answer itself, roughly five and a half
seconds in the normal case, and the threshold below which it is skipped dropped
accordingly.

Each request logs its own duration as `musik-box <type> in <n> ms`, and every
login logs `musik-box FRITZ!NAS-Login ok nach <n> ms, <n> ms Budget uebrig`.
Those two lines separate the skill's own work from the cold start, which the
Vercel timing alone cannot, and say whether the login was the reason.

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
| Alexa confirms, then silence | URL is not a direct file, not https, or the certificate is invalid | **Check URLs** in the dashboard; the URL must play in a browser straight away |
| Alexa confirms, then silence — FRITZ!NAS, large file | the track plays longer than a session number lasts | **Check URLs** now shows ⏳ for those; split the file into chapters, see below |
| "Ich komme gerade nicht an die FRITZ!Box" | no session number could be fetched | the box was unreachable or slow; say it again. The login now gets whatever is left of the time budget instead of a fixed four seconds — see below |
| First track plays, then silence | `PlaybackNearlyFinished` got no `ENQUEUE` | Vercel logs of `/api/skill` |
| "Weiter" restarts the track | host without range support | **Check URLs** shows ⚠️ — pick another host |
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
