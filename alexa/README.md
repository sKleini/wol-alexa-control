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

## Personen pflegen

Jede Person aus dem Dashboard muss als Wert unter `PERSON_NAME` stehen. Ein
Name, der dort fehlt, wird nicht erkannt — der Skill antwortet dann
*„Ich habe keine Person namens … gefunden."*

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
