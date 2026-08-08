// alexa/pruefe-modell.mjs – prueft das Interaction Model, bevor es die Konsole tut.
//
// Das Modell wird von Hand in die Developer Console eingefuegt und dort
// gebaut. Was daran nicht stimmt, faellt also erst dort auf - nach dem
// Einfuegen, nach dem Build, ein paar Minuten spaeter. Diese Pruefung holt die
// Beanstandungen dorthin, wo sie hingehoeren: in den Pull Request.
//
// Sie ersetzt den Build nicht. Sie kennt die drei Fehler, die hier schon
// vorgekommen sind oder die stillbleiben wuerden.
import { readFileSync } from 'fs'

const MODELL = new URL('./interaction-model.de-DE.json', import.meta.url);
const SKILL = new URL('../api/skill.js', import.meta.url);

const modell = JSON.parse(readFileSync(MODELL, 'utf8'));
const lm = modell.interactionModel.languageModel;
const dialog = modell.interactionModel.dialog || { intents: [] };
const prompts = modell.interactionModel.prompts || [];
const quelle = readFileSync(SKILL, 'utf8');

const beanstandungen = [];
const ruege = (text) => beanstandungen.push(text);

/**
 * **Ein Slot muss ein eigenes Wort sein.** `{person}s handy` ist ungueltig -
 * genau daran ist der erste Build gescheitert, mit acht Beanstandungen auf
 * einmal. Der deutsche Genitiv laesst sich so nicht bilden; es heisst "das
 * handy von {person}".
 */
function slotsStehenFrei(wo, satz) {
  for (const treffer of satz.match(/\{[a-zA-Z_]+\}/g) || []) {
    const i = satz.indexOf(treffer);
    const davor = i === 0 ? ' ' : satz[i - 1];
    const danach = satz[i + treffer.length] ?? ' ';
    if (davor !== ' ' || danach !== ' ') {
      ruege(`${wo}: Slot klebt an einem Zeichen - ${JSON.stringify(satz)}`);
    }
  }
}

for (const intent of lm.intents) {
  for (const satz of intent.samples || []) slotsStehenFrei(intent.name, satz);
}
for (const p of prompts) {
  for (const v of p.variations || []) slotsStehenFrei(p.id, v.value);
}

/**
 * Jeder Satz muss die Slots benutzen, die der Intent kennt - ein Tippfehler im
 * Namen wuerde sonst als gewoehnliches Wort verstanden.
 */
for (const intent of lm.intents) {
  const bekannt = (intent.slots || []).map(s => s.name);
  for (const satz of intent.samples || []) {
    for (const treffer of satz.match(/\{([a-zA-Z_]+)\}/g) || []) {
      const name = treffer.slice(1, -1);
      if (!bekannt.includes(name)) {
        ruege(`${intent.name}: unbekannter Slot {${name}} in ${JSON.stringify(satz)}`);
      }
    }
  }
}

/** Der Dialog-Abschnitt darf nur Intents kennen, die es auch gibt. */
const namen = lm.intents.map(i => i.name);
for (const i of dialog.intents || []) {
  if (!namen.includes(i.name)) ruege(`dialog: ${i.name} fehlt im languageModel`);
  if (i.confirmationRequired) {
    const id = i.prompts?.confirmation;
    if (!prompts.some(p => p.id === id)) {
      ruege(`dialog: ${i.name} verlangt eine Bestaetigung, aber der Prompt "${id}" fehlt`);
    }
  }
}

/**
 * **Die Naht, an der es sonst still bricht.** Ein Intent, den api/skill.js
 * behandelt, der hier aber fehlt, kommt beim Sprechen nie an - der Skill
 * antwortet "Das habe ich leider nicht verstanden", ohne Fehler und ohne Log.
 * Umgekehrt landet ein Intent, den nur das Modell kennt, im default-Zweig.
 */
const imCode = [...quelle.matchAll(/case '([A-Za-z]+Intent)':/g)].map(m => m[1])
  .filter(n => !n.startsWith('AMAZON.'));
for (const n of imCode) {
  if (!namen.includes(n)) ruege(`api/skill.js behandelt ${n}, das Modell kennt ihn nicht`);
}
for (const n of namen.filter(n => !n.startsWith('AMAZON.'))) {
  if (!imCode.includes(n)) ruege(`Das Modell kennt ${n}, api/skill.js behandelt ihn nicht`);
}

/** Ohne Personen als Slot-Werte wird kein einziger Name erkannt. */
const personen = (lm.types.find(t => t.name === 'PERSON_NAME')?.values || [])
  .map(v => v.name.value);
if (personen.length === 0) ruege('PERSON_NAME hat keine Werte - kein Name wuerde erkannt');

if (beanstandungen.length) {
  for (const b of beanstandungen) console.error(`::error::${b}`);
  console.error(`${beanstandungen.length} Beanstandung(en)`);
  process.exit(1);
}

console.log(`Modell ok - ${namen.length} Intents, Personen: ${personen.join(', ')}`);
