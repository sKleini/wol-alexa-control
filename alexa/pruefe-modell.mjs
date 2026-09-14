// alexa/pruefe-modell.mjs – prueft das Interaction Model, bevor es die Konsole tut.
//
// Das Modell wird von Hand in die Developer Console eingefuegt und dort
// gebaut. Was daran nicht stimmt, faellt also erst dort auf - nach dem
// Einfuegen, nach dem Build, ein paar Minuten spaeter. Diese Pruefung holt die
// Beanstandungen dorthin, wo sie hingehoeren: in den Pull Request.
//
// Sie ersetzt den Build nicht. Sie kennt die drei Fehler, die hier schon
// vorgekommen sind oder die stillbleiben wuerden.
//
// Zwei Skills, zwei Modelle, eine Pruefung:
//
//   node alexa/pruefe-modell.mjs
//     -> familien finder: interaction-model.de-DE.json gegen api/skill.js
//   node alexa/pruefe-modell.mjs alexa/interaction-model-musik.de-DE.json lib/musik.js PLAYLIST_NAME
//     -> musik box: das zweite Modell gegen den Handler in lib/musik.js
//
// Der dritte Parameter ist der Slot-Typ, der Werte haben muss - sonst wuerde
// kein einziger Name erkannt.
import { readFileSync } from 'fs'

const [modellPfad, quellPfad, slotTyp] = process.argv.slice(2);
const MODELL = modellPfad
  ? new URL(modellPfad, `file://${process.cwd()}/`)
  : new URL('./interaction-model.de-DE.json', import.meta.url);
const SKILL = quellPfad
  ? new URL(quellPfad, `file://${process.cwd()}/`)
  : new URL('../api/skill.js', import.meta.url);
const SLOT_TYP = slotTyp || 'PERSON_NAME';
const QUELLE_NAME = quellPfad || 'api/skill.js';

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
  if (!namen.includes(n)) ruege(`${QUELLE_NAME} behandelt ${n}, das Modell kennt ihn nicht`);
}
for (const n of namen.filter(n => !n.startsWith('AMAZON.'))) {
  if (!imCode.includes(n)) ruege(`Das Modell kennt ${n}, ${QUELLE_NAME} behandelt ihn nicht`);
}

/**
 * Die eingebauten Intents, die der Code behandelt, muss das Modell ebenfalls
 * fuehren - AMAZON.PauseIntent und AMAZON.ResumeIntent verlangt die Konsole
 * sogar, sobald der AudioPlayer eingeschaltet ist. Fehlt einer, faellt der
 * Sprachbefehl still in den default-Zweig.
 */
const eingebautImCode = [...quelle.matchAll(/case '(AMAZON\.[A-Za-z]+Intent)':/g)].map(m => m[1]);
for (const n of new Set(eingebautImCode)) {
  if (!namen.includes(n)) ruege(`${QUELLE_NAME} behandelt ${n}, das Modell kennt ihn nicht`);
}

/** Ohne Werte im Slot-Typ wird kein einziger Name erkannt. */
const personen = (lm.types.find(t => t.name === SLOT_TYP)?.values || [])
  .map(v => v.name.value);
if (personen.length === 0) ruege(`${SLOT_TYP} hat keine Werte - kein Name wuerde erkannt`);

if (beanstandungen.length) {
  for (const b of beanstandungen) console.error(`::error::${b}`);
  console.error(`${beanstandungen.length} Beanstandung(en)`);
  process.exit(1);
}

console.log(`Modell ok - ${namen.length} Intents, ${SLOT_TYP}: ${personen.join(', ')}`);
