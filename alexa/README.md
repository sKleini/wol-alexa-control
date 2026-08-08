# Sprachmodell des Custom Skills

`interaction-model.de-DE.json` ist das Interaction Model des Skills
**familien finder** — dasselbe, das im **JSON Editor** der
[Alexa Developer Console](https://developer.amazon.com/alexa/console/ask) unter
*Interaction Model* steht.

**Warum es hier liegt, obwohl es nicht von hier deployt wird.** Das Modell lebt
in der Konsole; es gibt keinen Automatismus, der diese Datei dorthin bringt.
Trotzdem gehört es ins Repo: Es ist die andere Hälfte von `api/skill.js`. Ein
Intent-Name, der hier und dort auseinanderläuft, zeigt sich sonst als „Das habe
ich leider nicht verstanden" — ohne Fehler, ohne Log, ohne Hinweis darauf, wo
man suchen müsste. Wer `api/skill.js` ändert, sieht die Gegenseite hier im
selben Diff.

## Nach jeder Änderung

1. Konsole → Skill **familien finder** → *Interaction Model* → **JSON Editor**
2. Inhalt dieser Datei einfügen
3. **Build model** (dauert ein bis zwei Minuten)

Vorher lohnt sich

```bash
node alexa/pruefe-modell.mjs
```

— dieselbe Prüfung, die die CI fährt. Sie ersetzt den Build in der Konsole
nicht, kennt aber die Fehler, die hier schon vorgekommen sind.

## Ein Slot ist ein eigenes Wort

`{person}s handy` ist **kein gültiger Satz**. Genau daran ist der erste Build
gescheitert, mit acht Beanstandungen auf einmal:

```
Parsing error in sample: "RingPersonIntent: ob {person}s handy klingeln kann"
```

Der deutsche Genitiv lässt sich so nicht bilden. Es heißt deshalb überall
**„das handy von {person}"** — umständlicher zu lesen, aber es baut. Dieselbe
Regel gilt in den Prompts.

Was der Skill *spricht*, ist davon nicht betroffen: Dort steht „Julias Handy",
denn das ist gewöhnlicher Text aus `api/skill.js` und kein Sprachmuster.

## Personen pflegen — an zwei Stellen

Ein Name muss **beides** sein, sonst passiert nichts:

| Stelle | Wozu | Fehlt er dort, sagt Alexa |
| --- | --- | --- |
| `PERSON_NAME` in dieser Datei | damit Alexa den Namen überhaupt **hört** | *„Wessen Handy soll klingeln? Ich kenne …"* |
| Person im Dashboard (`geo_persons`) | damit der Skill weiß, **wen** er erreichen soll | *„Ich habe keine Person namens … gefunden."* |

Die beiden Meldungen sehen sich ähnlich und meinen Verschiedenes. Die erste ist
die verwirrendere: Sie klingt, als hätte man keinen Namen gesagt, obwohl man
einen gesagt hat — Alexa füllt den Slot schlicht nicht, wenn der Name hier
fehlt, und der Skill bekommt statt „Stefan" gar nichts. **Deshalb zählt die
Rückfrage die bekannten Namen mit auf**; wer sie hört, sieht den Grund sofort,
statt denselben Satz noch einmal zu sagen, nur lauter.

Die aufgezählten Namen kommen aus dem **Dashboard**, nicht aus dieser Datei:
Sie beantworten „wen kann dieser Skill erreichen", und das ist die Frage
dahinter. Steht ein Name hier, aber nicht dort, hört Alexa ihn — und der Skill
sagt dann ehrlich, dass er ihn nicht kennt.

## Die Rückfrage vor dem Klingeln

`confirmationRequired` steht im **`dialog`-Abschnitt** und nicht bei den Intents
im `languageModel`. Das ist keine Geschmacksfrage: An der anderen Stelle nimmt
die Konsole das Feld zwar an, wertet es aber nicht aus — die Rückfrage bliebe
aus, und das Handy klingelte sofort. Also genau das, wogegen sie da ist.

`delegationStrategy` steht auf `SKILL_RESPONSE`: Alexa fragt **nicht** von sich
aus, sondern reicht den Intent an `api/skill.js` durch, das mit einer
`Dialog.ConfirmIntent`-Direktive antwortet. So steht die Frage samt Name im
Code und nicht in zwei Fassungen an zwei Orten. Der Prompt
`Confirm.Intent.RingPerson` bleibt trotzdem stehen — das Schema verlangt ihn,
wenn `confirmationRequired` gesetzt ist.

**`SilencePersonIntent` hat bewusst keine Bestätigung.** Aufhören ist harmlos,
und wer das Handy gerade gefunden hat, während es Alarm schlägt, soll nicht
erst eine Frage beantworten. Die Vorsicht gehört vor das Geräusch, nicht
dahinter.
