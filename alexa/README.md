# Sprachmodelle der Custom Skills

`interaction-model.de-DE.json` ist das Interaction Model des Skills
**familien finder** — dasselbe, das im **JSON Editor** der
[Alexa Developer Console](https://developer.amazon.com/alexa/console/ask) unter
*Interaction Model* steht. `interaction-model-musik.de-DE.json` ist das Modell
des zweiten Skills **Musik Box** (README, Abschnitt 9); seine Gegenseite ist
`lib/musik.js`, nicht `api/skill.js` — beide Skills teilen sich den Endpunkt
`/api/skill`, der nach der Skill-ID verzweigt.

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
node alexa/pruefe-modell.mjs alexa/interaction-model-musik.de-DE.json lib/musik.js PLAYLIST_NAME
```

— dieselbe Prüfung, die die CI fährt (die erste Zeile für *familien finder*,
die zweite für *Musik Box*). Sie ersetzt den Build in der Konsole nicht, kennt
aber die Fehler, die hier schon vorgekommen sind — seit dem AudioPlayer auch
einen eingebauten Intent, den der Code behandelt und das Modell nicht führt:
`AMAZON.PauseIntent` und `AMAZON.ResumeIntent` verlangt die Konsole, sobald das
AudioPlayer-Interface eingeschaltet ist.

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

## Playlists pflegen (Musik Box)

**Eine neue Playlist gehört nur ins Dashboard.** Am Sprachmodell ist dafür
nichts mehr zu tun — seit `SuchePlaylistIntent` nimmt der Ein-Satz-Aufruf
(*„öffne meine plattenkiste und spiele Taschenlampe"*) einen `AMAZON.SearchQuery`-Slot,
also freien Text, und erkennt damit jeden Namen.

### Warum es zwei Intents sind

`AMAZON.SearchQuery` allein reicht nicht, denn ein Sample mit diesem Typ darf
**nicht** aus dem Slot allein bestehen und braucht ein Trägerwort davor. Genau
das verlangt aber die Antwort auf die Rückfrage:

> „Alexa, öffne meine plattenkiste" → *„Welche Playlist soll ich spielen?"* → „Taschenlampe"

Deshalb teilen sich zwei Intents die Arbeit, und ihre Satzmuster überschneiden
sich bewusst nicht:

| Intent | Slot-Typ | Sätze | wofür |
|---|---|---|---|
| `SuchePlaylistIntent` | `AMAZON.SearchQuery` | immer mit Trägerwort, Slot am Ende (`spiele {suche}`) | der Ein-Satz-Aufruf, beliebige Namen |
| `PlayPlaylistIntent` | `PLAYLIST_NAME` | `{playlist}` allein | die Antwort auf die Rückfrage |

Beide landen in derselben Funktion; welcher Slot ankommt, ist dem Rest egal.
`findePlaylist` normalisiert Groß- und Kleinschreibung, Umlaute und Leerzeichen
und trifft auch durch Füllwörter hindurch (*„mal die taschenlampe bitte"*).

### Was der Umbau gekostet hat

Drei Satzmuster mussten weichen, weil der Slot bei `AMAZON.SearchQuery` am Ende
stehen muss: *„Taschenlampe abspielen"*, *„Taschenlampe zu spielen"* und *„ich
möchte Taschenlampe hören"*. Wer eine dieser Formen vermisst, kann sie nicht
zurückholen — die Regel ist Amazons, nicht unsere.

### Die Werte unter PLAYLIST_NAME

Sie werden nicht mehr gebraucht, damit ein Name erkannt wird, und sind trotzdem
keine Altlast: Sie tragen die Rückfrage, und `api/skill.js` schiebt die echten
Namen aus dem Dashboard bei jeder Antwort als dynamische Werte nach. Die Liste
im Modell ist der Grundstock, falls ein Echo den Skill lange nicht benutzt hat.

### Woran es vorher hing (zweimal, mit Ansage)

Ein eigener Slot-Typ ist bei Alexa keine geschlossene Liste, aber er erkennt
Unbekanntes nur, wenn es den eingetragenen Werten **ähnelt**. Daran sind
nacheinander *„spiele Zähne putzen"* und *„spiele Taschenlampe"* gescheitert,
während im Modell nur `Kinderlieder` und `Hörspiele` standen. Die dynamischen
Werte fangen das nicht auf: Sie wirken erst **nach** einer Antwort des Skills,
und der Ein-Satz-Aufruf ist die erste Äußerung der Sitzung.

Am Handler lag es dabei nie — kommt der Name an, wird er gefunden. Das ist auch
die Probe, wenn wieder etwas nicht erkannt wird: Klappt es zweistufig
(erst öffnen, dann den Namen sagen) und in einem Satz nicht, liegt es am Modell.
