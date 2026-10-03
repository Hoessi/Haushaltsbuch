# Haushaltsbuch

Die App ist eine installierbare Web-App (PWA). Sie läuft offline, und alle Daten bleiben auf dem Gerät.
Damit sie sich installieren lässt, muss der Ordner einmal über HTTPS erreichbar sein.

## 1. Adresse
Die App ist über GitHub Pages veröffentlicht: https://hoessi.github.io/Haushaltsbuch/

Im Repository liegt nur der Programmcode, keine Kontodaten. Die Buchungen bleiben im Speicher des jeweiligen Geräts.

## 2. Auf dem Handy installieren
- iPhone (Safari): Adresse öffnen → Teilen-Symbol → „Zum Home-Bildschirm“.
- Android (Chrome): Adresse öffnen → Menü ⋮ → „App installieren“ bzw. „Zum Startbildschirm hinzufügen“.
- Computer (Chrome/Edge): Installieren-Symbol rechts in der Adressleiste.

## 3. Neue Umsätze dazuholen
Exportiere in deiner Banking-App die Umsätze als CSV und tippe in der App auf „Importieren“. Der Zeitraum darf sich mit früheren Exporten überschneiden. Vor dem Import zeigt die App, was passiert:
- Schon vorhandene Buchungen werden übersprungen, auch wenn du sie inzwischen bearbeitet hast.
- Buchungen, die du gelöscht hast, bleiben gelöscht.
- Selbst eingetragene Buchungen werden mit der passenden Bankbuchung abgeglichen statt doppelt angelegt. Deine Angaben bleiben.
- Kategorien, Budgets, Regeln und Einstellungen ändert der Import nicht.

Jeder Import lässt sich unter „Mehr“ → „Letzten Import rückgängig machen“ zurücknehmen.

## 4. Daten sichern
Die Daten liegen nur auf diesem Gerät. Wenn du die App löschst oder die Browserdaten leerst, sind sie weg.
Unter „Mehr“ → „Sicherung speichern“ legst du eine Sicherungsdatei an. Sie enthält alle Buchungen, Kategorien, Budgets, Regeln, den Kontostand und die Einstellungen der Übersicht.
Mit „Sicherung laden“ holst du alles zurück, auch auf einem anderen Gerät. Die App erinnert dich, wenn die letzte Sicherung älter als 30 Tage ist.

## 5. Aktualisieren
Neue Version: die Dateien im Repository ersetzen (index.html, sw.js mit erhöhter VERSION). Die App lädt die neue Version beim nächsten Öffnen mit Internet im Hintergrund und zeigt sie ab dem darauffolgenden Start. Deine Daten bleiben dabei erhalten.
