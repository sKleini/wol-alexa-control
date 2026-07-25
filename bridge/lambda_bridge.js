import https from 'https';

// Alexa spricht bei einem Smart-Home-Skill direkt diese Lambda an und reicht
// dabei KEINE ueberpruefbare Signatur weiter. Damit /api/alexa nicht fuer jeden
// offensteht, der die Vercel-URL kennt, schickt die Bridge ein gemeinsames
// Geheimnis im Header mit; der Endpunkt lehnt Anfragen ohne dieses Header ab.
//
// Einrichtung (einmalig, in der Lambda-Konsole): Umgebungsvariable BRIDGE_KEY
// anlegen und denselben Wert eintragen, der in Vercel als ADMIN_PASSWORD steht.
export const handler = async (event) => {
    const vercelUrl = 'https://YOUR-PROJECT.vercel.app/api/alexa';

    const body = JSON.stringify(event);
    const options = {
        method: 'POST',
        timeout: 8000,
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            'x-bridge-key': process.env.BRIDGE_KEY || ''
        }
    };

    return new Promise((resolve, reject) => {
        const req = https.request(vercelUrl, options, (res) => {
            let responseBody = '';
            res.on('data', (chunk) => responseBody += chunk);
            res.on('end', () => {
                // Ohne diese Pruefungen wirft ein 401/500 mit HTML-Body im
                // end-Callback eine ungefangene Exception: das Promise wuerde
                // nie aufgeloest und die Lambda haengt bis zum Timeout.
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    reject(new Error(`Vercel antwortete mit HTTP ${res.statusCode}: ${responseBody.slice(0, 200)}`));
                    return;
                }
                try {
                    resolve(JSON.parse(responseBody));
                } catch (e) {
                    reject(new Error(`Antwort war kein JSON: ${responseBody.slice(0, 200)}`));
                }
            });
            res.on('error', reject);
        });

        req.on('timeout', () => req.destroy(new Error('Zeitueberschreitung gegenueber Vercel')));
        req.on('error', (e) => reject(e));
        req.write(body);
        req.end();
    });
};
