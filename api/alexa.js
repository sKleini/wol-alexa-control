import { Redis } from '@upstash/redis'
import crypto from 'crypto'

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
})

// Shared secret between the Alexa Lambda bridge and this endpoint. Without it
// anyone who knows the deployment URL could POST a crafted directive and wake
// or shut down the PCs — Alexa itself sends no signature to a Smart Home
// Lambda, so this header is the only thing standing in front of the actions.
// Falls back to ADMIN_PASSWORD so no additional secret has to be provisioned.
function bridgeAuthorized(req) {
  const expected = process.env.BRIDGE_KEY || process.env.ADMIN_PASSWORD;
  if (!expected) return false; // fail closed: unconfigured means locked, not open
  const got = req.headers['x-bridge-key'];
  if (typeof got !== 'string' || got.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}

export default async function handler(req, res) {
  if (!bridgeAuthorized(req)) return res.status(401).end();

  const request = req.body;
  if (!request || !request.directive || !request.directive.header) return res.status(400).end();

  const namespace = request.directive.header.namespace;
  const name = request.directive.header.name;

  if (namespace === 'Alexa.Discovery' && name === 'Discover') {
    return handleDiscovery(request, res);
  }

  if (namespace === 'Alexa.PowerController') {
    return handlePowerControl(request, res);
  }

  if (namespace === 'Alexa.SceneController') {
    return handleSceneControl(request, res);
  }

  return res.status(200).json({
    event: {
      header: {
        namespace: "Alexa",
        name: "Response",
        messageId: request.directive.header.messageId + "-R",
        payloadVersion: "3"
      },
      payload: {}
    }
  });
}

async function handleDiscovery(request, res) {
  try {
    const messageId = request.directive.header.messageId;
    const devices = await redis.get('wol_devices') || [];

    const endpoints = devices.map(config => {

      const cleanId = config.mac.replace(/[: -]/g, '').toLowerCase();

      const formatMac = (rawMac) => {
        const clean = rawMac.replace(/[^a-fA-F0-9]/g, '').toLowerCase();
        if (clean.length !== 12) return clean;
        return clean.match(/.{1,2}/g).join(':');
      };

      return {
        endpointId: "endpoint-" + cleanId,
        manufacturerName: "Kleini",
        friendlyName: config.name,
        description: `PC WoL: ${config.name}`,
        displayCategories: ["COMPUTER"],
        capabilities: [
          {
            type: "AlexaInterface",
            interface: "Alexa.PowerController",
            version: "3",
            properties: {
              supported: [{ name: "powerState" }],
              proactivelyReported: false,
              retrievable: true
            }
          },
          {
            type: "AlexaInterface",
            interface: "Alexa.EndpointHealth",
            version: "3",
            properties: {
              supported: [{ name: "connectivity" }],
              proactivelyReported: false,
              retrievable: true
            }
          },
          {
            type: "AlexaInterface",
            interface: "Alexa.WakeOnLANController",
            version: "3",
            configuration: {
              MACAddresses: [formatMac(config.mac)]
            }
          },
          {
            type: "AlexaInterface",
            interface: "Alexa",
            version: "3"
          }
        ]
      };
    });

    endpoints.push({
      endpointId: "endpoint-fritzbox-led",
      manufacturerName: "Kleini",
      friendlyName: "Fritzbox LED",
      description: "LED-Anzeige der FRITZ!Box",
      displayCategories: ["LIGHT"],
      capabilities: [
        {
          type: "AlexaInterface",
          interface: "Alexa.PowerController",
          version: "3",
          properties: {
            supported: [{ name: "powerState" }],
            proactivelyReported: false,
            retrievable: true
          }
        },
        {
          type: "AlexaInterface",
          interface: "Alexa.EndpointHealth",
          version: "3",
          properties: {
            supported: [{ name: "connectivity" }],
            proactivelyReported: false,
            retrievable: true
          }
        },
        {
          type: "AlexaInterface",
          interface: "Alexa",
          version: "3"
        }
      ]
    });

    // Muelltonne: als Szene und nicht als Schalter, damit "Alexa, Muelltonne"
    // genuegt statt "Alexa, schalte Muelltonne ein" - es ist ja eine Frage und
    // kein Schaltvorgang. Ausgeloest wird nur eine Ansage auf dem VPS, es gibt
    // nichts zurueckzunehmen: supportsDeactivation false.
    endpoints.push({
      endpointId: "endpoint-abfall",
      manufacturerName: "Kleini",
      friendlyName: "Mülltonne",
      description: "Sagt die nächste Leerung an",
      displayCategories: ["SCENE_TRIGGER"],
      capabilities: [
        {
          type: "AlexaInterface",
          interface: "Alexa.SceneController",
          version: "3",
          supportsDeactivation: false
        },
        {
          type: "AlexaInterface",
          interface: "Alexa",
          version: "3"
        }
      ]
    });

    return res.status(200).json({
      event: {
        header: {
          namespace: "Alexa.Discovery",
          name: "Discover.Response",
          messageId: messageId + "-R",
          payloadVersion: "3"
        },
        payload: {
          endpoints: endpoints
        }
      }
    });
  } catch (err) {
    console.error("Discovery Error:", err);
    return res.status(500).json({ error: "Internal Error" });
  }
}

// "Alexa, Muelltonne" -> Nachricht aufs ntfy-Topic -> abfall-relay auf dem
// Strato-VPS -> Ansage der naechsten Leerung auf dem zuletzt angesprochenen
// Echo. Der VPS-Teil steckt in sKleini/wireguard-vps-strato (Workflow 30);
// hier wird nur veroeffentlicht. Antwort ist bewusst nur die Quittung - die
// eigentliche Auskunft kommt Sekunden spaeter als Ansage.
async function handleSceneControl(request, res) {
  const { header, endpoint } = request.directive;
  if (!endpoint || typeof endpoint.endpointId !== 'string') return res.status(400).end();
  const correlationToken = header.correlationToken;
  const messageId = header.messageId;
  const endpointId = endpoint.endpointId;
  const name = header.name;

  const fehler = (type, message) => res.status(200).json({
    event: {
      header: {
        namespace: "Alexa",
        name: "ErrorResponse",
        messageId: messageId + "-R",
        correlationToken: correlationToken,
        payloadVersion: "3"
      },
      endpoint: { endpointId: endpointId },
      payload: { type: type, message: message }
    }
  });

  // Nur auf die eine Szene reagieren, die wir auch veroeffentlicht haben -
  // dieselbe Vorsicht wie bei handlePowerControl.
  if (endpointId !== 'endpoint-abfall') {
    console.warn(`Scene Control for unknown endpoint: ${endpointId}`);
    return fehler("NO_SUCH_ENDPOINT", "Unknown endpoint");
  }

  // supportsDeactivation ist false; ein Deactivate sollte gar nicht kommen.
  if (name !== 'Activate') {
    return fehler("INVALID_DIRECTIVE", "Only Activate is supported");
  }

  if (!process.env.ABFALL_TOPIC || !process.env.ABFALL_PASSWORD) {
    console.error("ABFALL_TOPIC or ABFALL_PASSWORD not configured");
    return fehler("INTERNAL_ERROR", "ABFALL_TOPIC or ABFALL_PASSWORD not configured");
  }

  try {
    await fetch(`https://ntfy.sh/${process.env.ABFALL_TOPIC}`, {
      method: 'POST',
      body: `abfall:naechste:${process.env.ABFALL_PASSWORD}`
    });
    console.log("Sent abfall command: naechste");
  } catch (err) {
    console.error("Error sending abfall command to ntfy:", err);
  }

  return res.status(200).json({
    event: {
      header: {
        namespace: "Alexa.SceneController",
        name: "ActivationStarted",
        messageId: messageId + "-R",
        correlationToken: correlationToken,
        payloadVersion: "3"
      },
      endpoint: { endpointId: endpointId },
      payload: {
        cause: { type: "VOICE_INTERACTION" },
        timestamp: new Date().toISOString()
      }
    }
  });
}

async function sendWakeViaNtfy(cleanId) {
  const adminPassword = process.env.ADMIN_PASSWORD || "";
  const secretHash = crypto.createHash('sha256')
                           .update(cleanId + adminPassword)
                           .digest('hex')
                           .substring(0, 20);
  const topic = `wol_${secretHash}`;
  await fetch(`https://ntfy.sh/${topic}`, {
    method: 'POST',
    body: 'wake'
  });
  console.log(`Sent wake command to ntfy topic: ${topic}`);
}

async function handlePowerControl(request, res) {
  const { header, endpoint } = request.directive;
  if (!endpoint || typeof endpoint.endpointId !== 'string') return res.status(400).end();
  const correlationToken = header.correlationToken;
  const messageId = header.messageId;
  const endpointId = endpoint.endpointId;
  const name = header.name;

  console.log(`Power Control: ${name} for ${endpointId}`);

  const cleanId = endpointId.replace('endpoint-', '');

  // Only act on endpoints we actually published. Otherwise this handler would
  // hash any caller-supplied id together with ADMIN_PASSWORD and publish to the
  // resulting ntfy topic — effectively an oracle for arbitrary device ids.
  if (cleanId !== 'fritzbox-led') {
    const devices = await redis.get('wol_devices') || [];
    const known = devices.some(d => (d.mac || '').replace(/[: -]/g, '').toLowerCase() === cleanId);
    if (!known) {
      console.warn(`Power Control for unknown endpoint: ${endpointId}`);
      return res.status(200).json({
        event: {
          header: {
            namespace: "Alexa",
            name: "ErrorResponse",
            messageId: messageId + "-R",
            correlationToken: correlationToken,
            payloadVersion: "3"
          },
          endpoint: { endpointId: endpointId },
          payload: { type: "NO_SUCH_ENDPOINT", message: "Unknown endpoint" }
        }
      });
    }
  }

  if (cleanId === 'fritzbox-led') {
    if (!process.env.LED_TOPIC || !process.env.LED_PASSWORD) {
      console.error("LED_TOPIC or LED_PASSWORD not configured");
      return res.status(200).json({
        event: {
          header: {
            namespace: "Alexa",
            name: "ErrorResponse",
            messageId: messageId + "-R",
            correlationToken: correlationToken,
            payloadVersion: "3"
          },
          endpoint: {
            endpointId: endpointId
          },
          payload: {
            type: "INTERNAL_ERROR",
            message: "LED_TOPIC or LED_PASSWORD not configured"
          }
        }
      });
    }

    const action = name === 'TurnOn' ? 'on' : 'off';

    try {
      await fetch(`https://ntfy.sh/${process.env.LED_TOPIC}`, {
        method: 'POST',
        body: `led:${action}:${process.env.LED_PASSWORD}`
      });
      console.log(`Sent LED command: ${action}`);
    } catch (err) {
      console.error("Error sending LED command to ntfy:", err);
    }

    return res.status(200).json({
      event: {
        header: {
          namespace: "Alexa",
          name: "Response",
          messageId: messageId + "-R",
          correlationToken: correlationToken,
          payloadVersion: "3"
        },
        endpoint: {
          endpointId: endpointId
        },
        payload: {}
      },
      context: {
        properties: [
          {
            namespace: "Alexa.PowerController",
            name: "powerState",
            value: name === "TurnOn" ? "ON" : "OFF",
            timeOfSample: new Date().toISOString(),
            uncertaintyInMilliseconds: 0
          },
          {
            namespace: "Alexa.EndpointHealth",
            name: "connectivity",
            value: {
              value: "OK"
            },
            timeOfSample: new Date().toISOString(),
            uncertaintyInMilliseconds: 0
          }
        ]
      }
    });
  }

  if (name === 'TurnOn') {
    const cleanId = endpointId.replace('endpoint-', '');
    try {
      await sendWakeViaNtfy(cleanId);
    } catch (err) {
      console.error("Error sending wake via ntfy:", err);
    }
  }

  if (name === 'TurnOff') {
    const cleanId = endpointId.replace('endpoint-', '');
    const adminPassword = process.env.ADMIN_PASSWORD || "";

    const secretHash = crypto.createHash('sha256')
                             .update(cleanId + adminPassword)
                             .digest('hex')
                             .substring(0, 20);

    const topic = `wol_${secretHash}`;

    try {
      await fetch(`https://ntfy.sh/${topic}`, {
        method: 'POST',
        body: 'off'
      });
      console.log(`Sent secure shutdown command to topic: ${topic}`);
    } catch (err) {
      console.error("Error sending to ntfy:", err);
    }
  }

  return res.status(200).json({
    event: {
      header: {
        namespace: "Alexa",
        name: "Response",
        messageId: messageId + "-R",
        correlationToken: correlationToken,
        payloadVersion: "3"
      },
      endpoint: {
        endpointId: endpointId
      },
      payload: {}
    },
    context: {
      properties: [
        {
          namespace: "Alexa.PowerController",
          name: "powerState",
          value: name === "TurnOn" ? "ON" : "OFF",
          timeOfSample: new Date().toISOString(),
          uncertaintyInMilliseconds: 0
        },
        {
          namespace: "Alexa.EndpointHealth",
          name: "connectivity",
          value: {
            value: "OK"
          },
          timeOfSample: new Date().toISOString(),
          uncertaintyInMilliseconds: 0
        }
      ]
    }
  });
}
