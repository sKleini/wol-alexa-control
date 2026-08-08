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

## Personen pflegen

**Seit den dynamischen Werten reicht das Dashboard.** `api/skill.js` schickt bei
jeder Antwort eine `Dialog.UpdateDynamicEntities`-Direktive mit den Personen
aus `geo_persons` — Alexa lernt neue Namen also von selbst, ohne dass jemand
diese Datei anfassen müsste.

Zwei Grenzen gehören dazu, und deshalb bleibt die statische Liste stehen:

- Die dynamischen Werte gelten **pro Nutzer** und **zeitlich begrenzt**, nicht
  dauerhaft im Modell. Ein Echo, das den Skill lange nicht benutzt hat, fällt
  auf die statische Liste zurück.
- Sie wirken erst **nach** einer Antwort des Skills. Die allererste Frage nach
  einer eben angelegten Person kann also noch ins Leere gehen; die zweite nicht
  mehr.

Wer die Namen der Familie hier einträgt, bekommt sie also sofort und
zuverlässig; wer eine Person nur im Dashboard anlegt, bekommt sie ab dem
zweiten Satz. Beides ist in Ordnung — nur verlassen sollte man sich nicht auf
die Kulanz, die es früher gab:

> **Ein Name, der nirgends steht, kann eine Weile trotzdem funktionieren — und
> genau das war die Falle.** Ein eigener Slot-Typ ist bei Alexa keine
> geschlossene Liste: Unbekanntes kommt gelegentlich als
> `ER_SUCCESS_NO_MATCH` samt gesprochenem Wort durch. Genau so lief *„wo ist
> Amelia"*, obwohl Amelia nie im Modell stand — bis ein dritter Wert und zwei
> weitere Intents am selben Slot-Typ dazukamen und die Erkennung diese Kulanz
> aufgab. Der Satz hörte auf zu funktionieren, ohne dass jemand ihn angefasst
> hätte.

Kennt der Skill einen Namen gar nicht, sagt er es und zählt auf, wen er kennt
(*„Wessen Handy soll klingeln? Ich kenne …"*). Die Liste kommt aus dem
Dashboard, nicht aus dieser Datei: Sie beantwortet „wen kann dieser Skill
erreichen", und das ist die Frage dahinter.

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
