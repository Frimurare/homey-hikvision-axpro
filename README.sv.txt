Hikvision AX PRO — lokal larmintegration för Homey Pro

Ta in ditt Hikvision AX PRO trådlösa larmsystem i Homey. Appen pratar direkt
med larmpanelen över ditt lokala nätverk (inget molnkonto, ingen separat brygga)
och gör panelen, detektorerna och kringutrustningen till riktiga Homey-enheter
som du kan se, automatisera och styra.

VAD DEN GÖR
- Anslut en gång med panelens IP-adress och inloggning; appen hittar panelen och
  varje enrollad detektor och kringenhet, redo att läggas till.
- Tillkoppla (Borta), Deltillkoppla (Hemma) och Frånkoppla larmet direkt från
  Homey, med aktuellt tillkopplat-läge tillgängligt i Flows.
- Varje detektor blir en enhet med rätt sensortyp och egen ikon: rörelse,
  dörr/kontakt, rök, glaskross, vattenläckage, CO, gas, värme och panik.
- Detektorer rapporterar även temperatur, batterinivå och sabotage när det
  finns — så larmets temperaturer dyker upp i Homeys Climate-vy automatiskt.
- Kringutrustning stöds också: knappsatser, externa sirener, repeaters,
  taggläsare och relä-/utgångsmoduler (på/av).
- Nya detektorer du enrollar senare (t.ex. en ny garagesensor) dyker bara upp
  nästa gång du lägger till en enhet.

HUR DEN FUNGERAR
Allt körs lokalt på din Homey och kommunicerar direkt med panelen. Dina
inloggningsuppgifter stannar på Homeyn; inget molnberoende.

STÖDD HÅRDVARA
Hikvision AX PRO-paneler (DS-PWA96-M-WE / M2-WE / M2H-WE, DS-PWA64-L-WE) och
deras trådlösa detektorer och kringutrustning. Detektorer matchas efter typen
panelen rapporterar, så hela AX PRO-sortimentet täcks.

KOM IGÅNG
Lägg till enhet -> Hikvision AX PRO -> ange panelens IP-adress och användarnamn
och lösenord du använder till panelens webbsida -> välj enheter att lägga till.

KÄLLKOD, PROBLEM & BIDRAG
Öppen källkod (GPL-3.0). Kod, dokumentation och ärendehantering:
https://github.com/Frimurare/homey-hikvision-axpro

Byggd med kärlek av Ulf Holmström.

Hikvision och AX PRO är varumärken som tillhör respektive ägare. Detta är en
oberoende, inofficiell integration utan koppling till Hikvision.
