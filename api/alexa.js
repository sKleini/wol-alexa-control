import { Redis } from '@upstash/redis'
import crypto from 'crypto'

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
})

export default async function handler(req, res) {
  const request = req.body;
  if (!request || !request.directive) return res.status(400).end();

  const namespace = request.directive.header.namespace;
  const name = request.directive.header.name;

  if (namespace === 'Alexa.Discovery' && name === 'Discover') {
    return handleDiscovery(request, res);
  }

  if (namespace === 'Alexa.PowerController') {
    return handlePowerControl(request, res);
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
        manufacturerName: "FlowersPowerz",
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

async function getFritzBoxSID(baseUrl, user, password) {
  // Step 1: get challenge
  const r1 = await fetch(`${baseUrl}/login_sid.lua?version=2`);
  const xml1 = await r1.text();

  const sid0 = (xml1.match(/<SID>([^<]+)<\/SID>/) || [])[1] || '0000000000000000';
  if (sid0 !== '0000000000000000') return sid0;

  const challenge = (xml1.match(/<Challenge>([^<]+)<\/Challenge>/) || [])[1] || '';
  let response;

  if (challenge.startsWith('2$')) {
    // PBKDF2 method (Fritz!OS 7.24+): "2$iter1$salt1hex$iter2$salt2hex"
    const parts = challenge.split('$');
    const iter1 = parseInt(parts[1]);
    const salt1 = Buffer.from(parts[2], 'hex');
    const iter2 = parseInt(parts[3]);
    const salt2 = Buffer.from(parts[4], 'hex');
    const k1 = crypto.pbkdf2Sync(Buffer.from(password, 'utf8'), salt1, iter1, 32, 'sha256');
    const k2 = crypto.pbkdf2Sync(k1, salt2, iter2, 32, 'sha256');
    response = `${parts[4]}$${k2.toString('hex')}`;
  } else {
    // MD5 method (older firmware)
    const hash = crypto.createHash('md5')
      .update(Buffer.from(`${challenge}-${password}`, 'utf16le'))
      .digest('hex');
    response = `${challenge}-${hash}`;
  }

  // Step 2: authenticate
  const body = new URLSearchParams({ username: user, response }).toString();
  const r2 = await fetch(`${baseUrl}/login_sid.lua?version=2`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const xml2 = await r2.text();
  const sid = (xml2.match(/<SID>([^<]+)<\/SID>/) || [])[1] || '0000000000000000';

  if (sid === '0000000000000000') throw new Error('Fritz!Box login failed — check FRITZBOX_USER and FRITZBOX_PASSWORD');
  return sid;
}

async function sendWoLViaFritzBox(macAddress) {
  const fritzUrl = process.env.FRITZBOX_URL;
  const user = process.env.FRITZBOX_USER || '';
  const password = process.env.FRITZBOX_PASSWORD || '';

  if (!fritzUrl || !password) {
    console.error("Fritz!Box not configured: missing FRITZBOX_URL or FRITZBOX_PASSWORD");
    return;
  }

  const formatMac = (rawMac) => {
    const clean = rawMac.replace(/[^a-fA-F0-9]/g, '').toUpperCase();
    return clean.match(/.{1,2}/g).join(':');
  };

  const parsedUrl = new URL(fritzUrl);
  const baseUrl = `${parsedUrl.protocol}//${parsedUrl.host}`;

  try {
    console.log(`Fritz!Box Web-UI login at ${baseUrl}`);
    const sid = await getFritzBoxSID(baseUrl, user, password);
    console.log(`Fritz!Box SID obtained, sending WoL for ${formatMac(macAddress)}`);

    // Get device list to find UID by MAC
    const listBody = new URLSearchParams({ xhr: '1', sid, page: 'netDev' }).toString();
    const listRes = await fetch(`${baseUrl}/data.lua`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: listBody
    });
    const listData = await listRes.json();

    const targetMac = formatMac(macAddress).toUpperCase();
    const allDevices = [
      ...(listData?.data?.active || []),
      ...(listData?.data?.passive || [])
    ];
    const device = allDevices.find(d => d.mac?.toUpperCase() === targetMac);

    if (!device?.UID) {
      console.error(`Device ${targetMac} not found in Fritz!Box device list`);
      console.error(`Available MACs: ${allDevices.map(d => d.mac).join(', ')}`);
      return;
    }

    console.log(`Found device UID: ${device.UID}, sending WoL`);

    const wolBody = new URLSearchParams({ xhr: '1', sid, page: 'netDev', wakeup: '1', dev: device.UID }).toString();
    const wolRes = await fetch(`${baseUrl}/data.lua`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: wolBody
    });

    if (!wolRes.ok) {
      const text = await wolRes.text();
      console.error(`Fritz!Box WoL failed: ${wolRes.status} — ${text.substring(0, 300)}`);
    } else {
      console.log(`Fritz!Box WoL sent successfully for MAC: ${targetMac}`);
    }
  } catch (err) {
    console.error(`Fritz!Box WoL error: ${err.message}`);
  }
}

async function handlePowerControl(request, res) {
  const { header, endpoint } = request.directive;
  const correlationToken = header.correlationToken;
  const messageId = header.messageId;
  const endpointId = endpoint.endpointId;
  const name = header.name;

  console.log(`Power Control: ${name} for ${endpointId}`);

  if (name === 'TurnOn') {
    const cleanId = endpointId.replace('endpoint-', '');

    try {
      const devices = await redis.get('wol_devices') || [];
      const device = devices.find(d => d.mac.replace(/[: -]/g, '').toLowerCase() === cleanId);

      if (device) {
        await sendWoLViaFritzBox(device.mac);
      } else {
        console.error(`Device not found for endpointId: ${endpointId}`);
      }
    } catch (err) {
      console.error("Error sending WoL via Fritz!Box:", err);
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
