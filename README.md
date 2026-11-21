# Genderfreies Internet

Blendet Webseiten mit Gendersprache aus den Suchergebnissen von Google, Google News, Bing, Brave Search und DuckDuckGo aus. Ein grüner Stern kennzeichnet positiv geprüfte Domains, ein grauer Stern noch nicht geprüfte Domains.

- **Aktuelle Version:** 1.0.2
- **Chromium:** Chrome und Brave ab Chromium 137
- **Safari:** manuelle GitHub-Fassung für Mac ab macOS 27

## Downloads

- [⬇ Chrome-/Brave-Fassung herunterladen](https://github.com/marioco/GenderfreiesInternet/raw/refs/heads/main/GenderfreiesInternet.zip)
- [⬇ Safari-Fassung für den Mac herunterladen](https://github.com/marioco/GenderfreiesInternet/raw/refs/heads/main/GenderfreiesInternet-Safari.zip)
- [Einfache Safari-Installationsanleitung](https://lauraklaertdas.de/projekt/genderfreies-internet/safari/)

Die Safari-Fassung wird **ausschließlich über GitHub** und **nicht über den App Store** angeboten.

## Neu in Version 1.0.2

Google-News-Quellen werden nach vorübergehenden Auflösungsfehlern automatisch erneut angefragt.
Bereits sichtbare graue Sterne wechseln ohne Neuladen auf den geprüften Status, sobald Google die
Quelle wieder liefert.

## Safari auf dem Mac installieren

1. Die [Safari-Fassung](https://github.com/marioco/GenderfreiesInternet/raw/refs/heads/main/GenderfreiesInternet-Safari.zip) herunterladen und vollständig entpacken.
2. In Safari **Safari → Einstellungen → Erweitert** öffnen.
3. **Funktionen für Webentwickler anzeigen** aktivieren.
4. Den neuen Bereich **Entwickler** öffnen.
5. **Temporäre Erweiterung hinzufügen** wählen.
6. Den entpackten Ordner auswählen, in dem `manifest.json` liegt.
7. Eine unterstützte Suchseite öffnen und GF den Websitezugriff erlauben.

Safari behandelt diesen Download als temporäre Entwicklererweiterung. Wird GF nach einem Neustart nicht mehr angezeigt, muss derselbe Ordner erneut hinzugefügt werden. Programmupdates werden manuell von GitHub geladen; der signierte Filterdatenbestand aktualisiert sich weiterhin automatisch. Das ZIP lässt sich nicht direkt auf iPhone oder iPad installieren.

## Chrome oder Brave manuell installieren

1. Die [Chrome-/Brave-Fassung](https://github.com/marioco/GenderfreiesInternet/raw/refs/heads/main/GenderfreiesInternet.zip) herunterladen und entpacken.
2. In Chrome `chrome://extensions` oder in Brave `brave://extensions` öffnen.
3. **Entwicklermodus** einschalten.
4. **Entpackte Erweiterung laden** wählen.
5. Den entpackten Ordner `GenderfreiesInternet` auswählen.

Eine direkt von GitHub geladene Programmversion muss bei einem Update manuell ersetzt werden. Installationen aus dem Chrome Web Store werden dagegen automatisch aktualisiert.

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

Version 1.0.2 verwendet den produktiven Filterdienst auf der [Projektseite von Laura klärt das](https://lauraklaertdas.de/projekt/genderfreies-internet/). Der Browser lädt einen signierten Datenbestand und prüft alle 30 Minuten auf Änderungen. Bei einem vorübergehenden Netzausfall bleibt der letzte gültige lokale Stand verfügbar. Server, Datenbank, Crawler und KI-Prüfung sind bewusst **nicht** Teil dieses öffentlichen Repositorys.

## Datenschutz

Domains sichtbarer Suchergebnisse werden für die Filterung lokal verarbeitet. Domainmeldungen werden nur nach ausdrücklichem Klick übertragen; die zusätzliche Ausblendungsstatistik ist standardmäßig ausgeschaltet. Suchbegriffe, vollständige URLs und Seiteninhalte werden nicht an den Betreiber übertragen. Einzelheiten stehen in der [Datenschutzerklärung](https://lauraklaertdas.de/genderfrei/datenschutz/).

## Quellcode und Prüfsummen

Der veröffentlichte Browsercode befindet sich im Ordner [`extension`](extension). Die SHA-256-Prüfsummen der Downloads stehen in [`SHA256SUMS`](SHA256SUMS).
