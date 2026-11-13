# Genderfreies Internet

## [⬇ Aktuelle Version direkt herunterladen (ZIP)](https://github.com/marioco/GenderfreiesInternet/raw/refs/heads/main/GenderfreiesInternet.zip)

Blendet Webseiten mit Gendersprache aus den Suchergebnissen von Google, Google News, Bing, Brave Search und DuckDuckGo aus. Ein grüner Stern kennzeichnet positiv geprüfte Domains, ein grauer Stern noch nicht geprüfte Domains.

- **Aktuelle Version:** 0.8.8
- **Browser:** Google Chrome und Brave

## Installation

1. Das [aktuelle ZIP herunterladen](https://github.com/marioco/GenderfreiesInternet/raw/refs/heads/main/GenderfreiesInternet.zip).
2. ZIP-Datei entpacken.
3. In Chrome `chrome://extensions` oder in Brave `brave://extensions` öffnen.
4. **Entwicklermodus** einschalten.
5. **Entpackte Erweiterung laden** wählen.
6. Den entpackten Ordner `suchfilter-beta` auswählen.

Bei dieser entpackten Testversion muss ein neues ZIP weiterhin manuell entpackt werden.
Installationen aus dem Chrome Web Store werden von Chrome und Brave dagegen automatisch im
Hintergrund aktualisiert.

## Was die Erweiterung kann

- positiv geprüfte Domains mit einem grünen Stern markieren
- unbekannte Domains mit einem grauen Stern markieren
- eine aktuell geöffnete Website zur Prüfung melden
- Suchmaschinen und Google News selbst von Meldungen ausschließen
- hartes Gendern standardmäßig und leichtes Gendern auf Wunsch ausblenden
- 20 vordefinierte und bis zu 20 eigene Domain-Ausnahmen verwalten
- den signierten Datenbestand und zwischenzeitliche Änderungen automatisch aktualisieren
- zeitweilige Meldesperren sichtbar am orangefarbenen GF-Symbol anzeigen
- Hilfe, Einstellungen und die Datenschutzerklärung direkt erreichbar machen

## Unterstützte Suchmaschinen

- Google
- Google News
- Bing
- Brave Search
- DuckDuckGo

## Datenstand und Serververbindung

Version 0.8.8 verwendet den produktiven Filterdienst auf
[`lauraklaertdas.de`](https://lauraklaertdas.de/genderfrei/). Der Browser lädt einen
signierten Datenbestand und prüft alle 30 Minuten auf Änderungen. Bei einem vorübergehenden
Netzausfall bleibt der letzte gültige lokale Stand verfügbar. Server, Datenbank, Crawler und
KI-Prüfung sind bewusst **nicht** Teil dieses öffentlichen Repositorys.

## Datenschutz

Domains sichtbarer Suchergebnisse werden für die Filterung lokal verarbeitet. Domainmeldungen
werden nur nach ausdrücklichem Klick übertragen; die zusätzliche Ausblendungsstatistik ist
standardmäßig ausgeschaltet. Suchbegriffe, vollständige URLs und Seiteninhalte werden nicht an
den Betreiber übertragen. Einzelheiten stehen in der
[Datenschutzerklärung](https://lauraklaertdas.de/genderfrei/datenschutz/).

## Quellcode des Plugins

Der veröffentlichte Browser-Code befindet sich im Ordner [`extension`](extension). Das fertige Installationspaket ist [`GenderfreiesInternet.zip`](GenderfreiesInternet.zip).

## Prüfsumme

Die SHA-256-Prüfsumme des aktuellen ZIP steht in [`SHA256SUMS`](SHA256SUMS).
