# Utvecklingsanteckningar

Löpande noteringar för vidareutveckling av appen. Uppdateras när något
upptäcks som är värt att minnas till nästa gång.

## Öppna punkter

### Publiceringsflödet stannar efter validering
`homey app publish` kommer fram till `App validated successfully against level
publish` och står sedan still — uppladdningen sker aldrig och inget dyker upp i
dev-portalen. Inträffade 2026-07-26, flera försök.

Observationer:
- Homey CLI 4.0.5 installerad på byggmaskinen (VM101); CLI:t self-rapporterar
  att 4.4.1 finns. Uppgradering ej testad — **börja där** nästa gång.
- Hjälpskriptet på skrivbordet pipade utskriften genom `Tee-Object` för
  loggning. Pipen misstänktes bryta det interaktiva flödet, men samma pipe
  fanns i den version som fungerade i juli → hypotesen är **inte bevisad**.
- Varje avbrutet försök bumpar `app.json` (svarar man "Yes" på versionsfrågan).
  Ej publicerade nummer är osynliga för Athom, men CLI:t vägrar gå nedåt till
  ett nummer som redan stått i `app.json`. Svara **n** om versionen redan är satt.
- Publiceringen lyckades till slut som 1.1.7.

Nästa steg: uppgradera CLI till 4.4.x, kör publicering utan pipe och fånga
`--verbose`/loggutskrift för att se var uppladdningen faktiskt fastnar.

### 868 MHz-mottagning direkt i Homey (idé, ej utredd färdigt)
Homeys SDK exponerar egna RF-signaler (ASK/FSK) på 433/868. Dokumentationen
säger dock att 868 endast finns på *Homey Pro 2019 eller äldre*, medan Athoms
produktspecar listar 868 för Early 2023 — motstridiga uppgifter, avgörande för
om t.ex. Fine Offset-sensorer kan läsas direkt. Homey matchar dessutom bara mot
förregistrerade signaldefinitioner; råa ramar kan inte inspekteras.
Utred mot Athom-support/community innan tid läggs på en avkodare.

## Beslut & lärdomar

- **Pollningsintervall 30 s** (v1.1.7). Var 5 s (default i `ApiPoller`), vilket
  gav ~36 anrop/minut mot en liten inbyggd panel utan nytta: larmhändelser
  kommer ändå i realtid via `alertStream`, pollningen uppdaterar bara status.
- **AX PRO klarar inte många samtidiga sessioner.** Panelens sessionstabell är
  liten; upprepade inloggningar (ett skript som loggar in per anrop) gör den
  oåtkomlig i 15–20 min — den svarar med *timeout*, inte felkod, så det ser ut
  som en hängning. Därför: EN delad session per panel (`ApiPoller`), aktiv
  `logout()` vid fel, och exponentiell backoff 30 s → 60 s → 5 min → 15 min.
  Detta gäller även felsökningsverktyg — poll aldrig panelen ad hoc.
- **Sabotagelarm (tamper)** rapporteras så länge panelen inte sitter i sitt
  väggfäste. Förväntat vid bänktest, inget fel.
