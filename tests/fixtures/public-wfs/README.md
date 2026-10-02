# Captured public WFS responses

Small service responses (line endings and insignificant trailing whitespace normalized) retrieved on 2 October 2026. These are real municipal observations, not generated fixtures. They let normal CI replay parser/schema regressions without depending on public service uptime. `scripts/test-public-wfs.mjs` separately exercises the live endpoints in Chromium.

## Hamburg

Endpoint: https://geodienste.hamburg.de/HH_WFS_Strassenbaumkataster

Layer: `de.hh.up:strassenbaumkataster`.

- `hamburg-capabilities.xml`: WFS 2.0 GetCapabilities.
- `hamburg-schema.xsd`: WFS 2.0 DescribeFeatureType.
- `hamburg-page.json`, `hamburg-page.gml`: WFS 2.0 GetFeature, count=2, CRS84, respectively `application/geo+json` and `application/gml+xml; version=3.2`.

Licence as advertised by the service: [Datenlizenz Deutschland – Namensnennung – Version 2.0](https://www.govdata.de/dl-de/by-2-0).

Required source attribution: **Freie und Hansestadt Hamburg, Behörde für Umwelt, Klima, Energie und Agrarwirtschaft**. The individual records and schema declarations have not been modified. Browser replays may adjust collection totals or split members for test pagination; the individual records remain unchanged.

## Berlin

Endpoint: https://gdi.berlin.de/services/wfs/baumbestand

Layer: `baumbestand:strassenbaeume`.

- `berlin-schema.xsd`: WFS 2.0 DescribeFeatureType.
- `berlin-page.json`, `berlin-page.gml`: WFS 2.0 GetFeature, count=2, CRS84, respectively `application/json` and `application/gml+xml; version=3.2`.
- `berlin-1.1.0.gml`: GetFeature, maxFeatures=2, CRS84, `text/xml; subtype=gml/3.1.1`.
- `berlin-1.0.0.gml`: GetFeature, maxFeatures=2, CRS84, `GML2`.

Provider: **Senatsverwaltung für Stadtentwicklung, Bauen und Wohnen Berlin**. Licence advertised by the service: [Datenlizenz Deutschland – Zero – Version 2.0](https://www.govdata.de/dl-de/zero-2-0).

The older-version captures have a different default ordering from the WFS 2.0 captures. Live comparisons explicitly request a stable unique sort field. GML and GeoJSON can encode numbers at different precision, omit null attributes, or add standard GML bounds metadata.
