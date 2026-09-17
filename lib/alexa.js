// lib/alexa.js – Helfer fuer Custom-Skill-Antworten, die sich zwei Skills teilen.
//
// **Warum eine eigene Datei.** api/skill.js beantwortet inzwischen zwei Skills
// ("familien finder" und "meine plattenkiste"), und das Limit von zwoelf Funktionen unter
// api/ laesst keine dritte Datei zu. Die Musik-Logik liegt deshalb in
// lib/musik.js - und braeuchte von dort aus dieselben Helfer, die bisher in
// api/skill.js standen. Ein Import von lib/ nach api/ waere ein Kreis
// (api/skill.js importiert lib/musik.js), also wohnen die Helfer hier und
// api/skill.js reicht sie weiter, damit bestehende Aufrufer nichts merken.

/** Die gewoehnliche Antwort: ein Satz, optional mit Direktiven. */
export function speak(res, text, endSession = true, direktiven = []) {
  const response = {
    outputSpeech: { type: 'PlainText', text },
    shouldEndSession: endSession,
  };
  if (direktiven.length) response.directives = direktiven;
  return res.status(200).json({ version: '1.0', response });
}

/**
 * Der aufgeloeste Slot-Wert – **ueber alle Autoritaeten hinweg.**
 *
 * Frueher stand hier `resolutionsPerAuthority?.[0]`, und das war genau so
 * lange richtig, wie es nur eine Autoritaet gab. Mit den dynamischen Werten
 * (siehe [dynamischeEntitaeten]) sind es zwei: die statische Liste aus dem
 * Sprachmodell und die zur Laufzeit nachgeschobene. Fuer eine frisch angelegte
 * Person meldet die statische `ER_SUCCESS_NO_MATCH` - und stuende sie vorn,
 * fiele der Treffer der dynamischen unter den Tisch. Der ganze Nutzen der
 * Dynamik haenge dann daran, in welcher Reihenfolge Alexa die beiden schickt.
 *
 * Deshalb: die erste Autoritaet mit Treffer gewinnt, egal an welcher Stelle
 * sie steht. Ohne Treffer bleibt der gesprochene Wert - die Kulanz, auf die
 * sich dieser Skill nicht mehr verlaesst, die aber auch nicht schadet.
 *
 * Rein und exportiert, damit sich das ohne Netz pruefen laesst.
 */
export function resolvedSlotValue(slot) {
  if (!slot) return null;
  for (const a of slot.resolutions?.resolutionsPerAuthority || []) {
    if (a?.status?.code === 'ER_SUCCESS_MATCH') {
      return a.values?.[0]?.value?.name || slot.value;
    }
  }
  return slot.value || null;
}

/**
 * Zaehlt Namen so auf, wie man sie spricht: "Julia, Oma Petra und Stefan".
 *
 * Rein und exportiert, damit die Aufzaehlung ohne Netz pruefbar bleibt.
 */
export function aufzaehlung(namen) {
  const liste = (namen || []).filter(n => typeof n === 'string' && n.trim());
  if (liste.length === 0) return '';
  if (liste.length === 1) return liste[0];
  return `${liste.slice(0, -1).join(', ')} und ${liste[liste.length - 1]}`;
}

/**
 * Schiebt Werte aus dem Dashboard zur Laufzeit in einen Slot-Typ des
 * Sprachmodells (`Dialog.UpdateDynamicEntities`).
 *
 * **Damit muss ein neuer Name nicht mehr in die Developer Console.** Bisher
 * war jeder Name doppelt zu pflegen: im Dashboard und als Wert im Modell. Wer
 * das zweite vergass, bekam eine Rueckfrage, die klang, als haette er
 * geschwiegen - und genau das ist mit „wo ist Amelia" passiert.
 *
 * Ersetzt werden nur die **dynamischen** Werte; die Liste im Modell bleibt
 * unberuehrt und traegt weiter. Beides zusammen ist Absicht: Die statischen
 * Namen gelten sofort und fuer jeden, die dynamischen fangen alles ab, was
 * seither dazugekommen ist.
 *
 * **Zwei Grenzen, die dazugehoeren:**
 *   - Sie gelten pro Nutzer und zeitlich begrenzt, nicht dauerhaft im Modell.
 *   - Sie wirken erst NACH dieser Antwort. Die allererste Frage nach einem
 *     eben angelegten Namen kann also noch ins Leere gehen; die zweite nicht
 *     mehr.
 *
 * Deshalb bleibt die statische Liste der Grundstock und wird nicht ersetzt.
 *
 * @param {string} typ   Name des Slot-Typs im Modell, z. B. PERSON_NAME
 * @param {string[]} namen
 */
export function dynamischeEntitaeten(typ, namen) {
  const werte = (namen || [])
    .map(n => (typeof n === 'string' ? n : '').trim())
    .filter(Boolean)
    .map(name => ({ id: name.toLowerCase().replace(/\s+/g, '-'), name: { value: name } }));
  if (werte.length === 0) return [];
  return [{
    type: 'Dialog.UpdateDynamicEntities',
    updateBehavior: 'REPLACE',
    types: [{ name: typ, values: werte }],
  }];
}
