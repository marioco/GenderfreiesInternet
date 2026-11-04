# Genderfreies Internet

## [⬇ Aktuelle Version direkt herunterladen (ZIP)](https://github.com/marioco/GenderfreiesInternet/raw/refs/heads/main/GenderfreiesInternet.zip)

Blendet Webseiten mit Gendersprache aus den Suchergebnissen von Google, Google News, Bing, Brave Search und DuckDuckGo aus. Ein grüner Stern kennzeichnet positiv geprüfte Domains, ein grauer Stern noch nicht geprüfte Domains.

- **Aktuelle Beta-Version:** 0.4.4
- **Browser:** Google Chrome und Brave

## Installation

1. Das [aktuelle ZIP herunterladen](https://github.com/marioco/GenderfreiesInternet/raw/refs/heads/main/GenderfreiesInternet.zip).
2. ZIP-Datei entpacken.
3. In Chrome `chrome://extensions` oder in Brave `brave://extensions` öffnen.
4. **Entwicklermodus** einschalten.
5. **Entpackte Erweiterung laden** wählen.
6. Den entpackten Ordner `suchfilter-beta` auswählen.

Nach einer Aktualisierung das neue ZIP entpacken und die Erweiterung auf der Erweiterungsseite neu laden.

## Was die Erweiterung kann

- Domains mit hartem oder leichtem Gendern aus Suchergebnissen ausblenden
- positiv geprüfte Domains mit einem grünen Stern markieren
- unbekannte Domains mit einem grauen Stern markieren
- eine aktuell geöffnete Website zur Prüfung melden
- Domain-Ausnahmen berücksichtigen
- Hilfe, Einstellungen und einen eingebauten Testplan anzeigen

## Unterstützte Suchmaschinen

- Google
- Google News
- Bing
- Brave Search
- DuckDuckGo

## Wichtiger Hinweis zur Beta

Die aktuelle Beta verbindet sich mit dem Filterdienst auf der Laura/Spark im lokalen Netzwerk. Außerhalb dieses Netzwerks ist der Filterdienst derzeit nicht erreichbar. Der Server, die Datenbank, Moderation und Crawler sind bewusst **nicht** Teil dieses öffentlichen Repositorys.

## Datenschutz

Die Erweiterung übermittelt keine vollständigen Suchanfragen und keine besuchten URLs für die Statistik. Für Filterung, Meldungen und aggregierte Zählungen werden ausschließlich normalisierte Domainnamen und notwendige technische Angaben verarbeitet. Details zeigt die Hilfeseite innerhalb der Erweiterung.

## Quellcode des Plugins

Der veröffentlichte Browser-Code befindet sich im Ordner [`extension`](extension). Das fertige Installationspaket ist [`GenderfreiesInternet.zip`](GenderfreiesInternet.zip).

## Prüfsumme

Die SHA-256-Prüfsumme des aktuellen ZIP steht in [`SHA256SUMS`](SHA256SUMS).
