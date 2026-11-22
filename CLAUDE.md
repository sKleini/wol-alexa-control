# Hinweise für Claude

Antworten und Texte im Repo auf **Deutsch**.

## Veröffentlichen

Vercel deployt `main` nach jedem Merge. Ablauf, wenn der Nutzer „PR und Merge“ sagt:
Pull Request gegen `main`, Prüfungen abwarten, Squash-Merge.

## Kleine Änderungen

Die Prüfungen hier (Workflows `alexa-modell.yml` und `api-funktionen.yml`) dauern nur Sekunden –
ein eigenes Label zum Überspringen gibt es deshalb nicht (anders als das Label `schnell` im Repo
`sKleini/wireguard-vps-strato`, dort dauern die Android-Tests Minuten).

- **Klein** sind: Texte, Abstände, Farben, Layout-Kleinigkeiten, Doku.
- **Nicht klein** sind: Logik, Amazon-/Alexa-Aufrufe, Sprachmodell (`alexa/`), Datenformate,
  Workflows. Im Zweifel nachfragen.

Für kleine Änderungen: Pull Request anlegen, sobald die Prüfungen grün sind mergen.

Die Zahl der Dateien unter `api/` ist auf **zwölf** begrenzt (Vercel Hobby) – neue Logik gehört
nach `lib/`.
