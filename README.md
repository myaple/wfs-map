# Million-point WFS map

A TypeScript proof of concept using **MapLibre GL JS 6.11.2**, an exact custom WebGL 2 point layer, a columnar filtering worker, and a deterministic development WFS service. Every loaded point remains available. No clusters, sampling, DOM markers, hover picking, or viewport-only WFS downloads.

## Run the supplied build — no dependency installation

Install **Node.js 22.18+ or 24+**, extract the archive, then:

```sh
cd million-wfs-map
node server/server.ts
```

Open **http://127.0.0.1:8787**. Click **Load all points** to load the default 3 million points. Change the generated count to test 1, 2, 5, or more million. The server accepts up to 50 million; browser RAM and GPU memory are the practical limits, and the client defaults to a 10 million safety limit. A limit never silently masquerades as a complete dataset.

The supplied `dist/` contains the app, its ingestion worker, the MapLibre worker, CSS and JavaScript dependencies. The development server uses only Node built-ins. No CDN, database, API key or npm installation is needed to run the supplied build. The grid basemap works offline; optionally enable the online OpenStreetMap basemap.

Direct link for automatic loading:

```text
http://127.0.0.1:8787/?points=3000000&autoload=1
```

The generated layer has eight filterable attributes: `id`, `category`, `status`, `value`, `timestamp`, `active`, `source`, and `quality`. Choose UK spread, worldwide or dense distribution. The same feature index always yields the same coordinates and metadata for a given distribution. The server generates only requested pages instead of allocating millions of objects at startup.

## Build and develop

```sh
npm ci
npm run dev
```

Development UI: http://localhost:5173. WFS: http://127.0.0.1:8787/wfs. `npm run dev` starts both processes, with Vite proxying WFS requests.

```sh
npm run build
npm start
```

An integrity-checked npm cache and dependency notices are vendored under `vendor/`. The packaged source-build cache targets **Linux x64**; rebuild offline on that platform with:

```sh
npm ci --offline --cache ./vendor/npm-cache --no-audit --no-fund
npm run build
```

The ready-built app runs on other Node-supported platforms too. Rebuilding on another platform needs that platform's optional native build packages; run `npm ci` once online, then `npm run vendor` to regenerate its offline cache. Browser-test Chromium binaries and Node itself are not vendored.

Optional Docker workflow:

```sh
docker build -t million-wfs-map .
docker run --rm -p 8787:8787 million-wfs-map
```

Docker is provided as a convenience; the tested startup path is Node. `HOST=0.0.0.0` exposes the server to your LAN; the default binds to localhost.

## Connect a real WFS

1. Enter its WFS URL. Existing vendor parameters or query tokens are preserved.
2. Choose the WFS version, click **Discover layers**, and select the feature type.
3. In compatibility settings, set the exact advertised output format. Prefer `application/json`; simple GML Point output also works.
4. Request `urn:ogc:def:crs:OGC:1.3:CRS84`, which uses longitude/latitude. If your server requires EPSG:4326 GML, set the GML axis order to match its response. GeoJSON always uses longitude/latitude.
5. If necessary, choose a stable, unique sort attribute such as `id`. The dataset should remain unchanged throughout the load.
6. Load all points, then add attribute rules and click **Apply filters**.

The browser must be allowed by the server's CORS policy. Otherwise serve this app behind a same-origin reverse proxy for your WFS. This project deliberately has no unrestricted backend URL-fetching proxy. Authentication works through same-origin cookies or endpoint URL tokens; cross-origin cookie flows, OAuth UI and custom authorization headers are not implemented.

The adapter discovers feature types with GetCapabilities, gets attribute types with DescribeFeatureType, attempts a GetFeature hits request, then requests paged features. A one-page lookahead overlaps transfer with parsing/packing. If hits is unavailable or unknown, loading continues until an empty page or the explicit client limit. It advances by the actual returned count, so server page caps are supported.

**Compatibility scope:** WFS 2.0 paging, GeoJSON FeatureCollection output or simple GML 2/3 Point members using `pos`/`coordinates`, primitive attributes, and coordinates that the server can return as geographic longitude/latitude. WFS 1.0/1.1 work only when the server implements the `startIndex` extension. This is not a complete OGC conformance implementation. MultiPoint, polygons, curves, arbitrary projected CRS decoding, compressed archives and geometry references are unsupported and fail explicitly. Points outside Web Mercator's ±85.05112878° latitude limit also fail explicitly.

Repeated feature IDs, repeated pages, changed counts, premature empty pages, ignored page sizes and invalid coordinates fail visibly. These checks cannot prove snapshot consistency if a server changes rows while preserving the count, supplies no IDs, or omits rows without detectable duplicates. Snapshot isolation and a stable unique sort remain server responsibilities. Heterogeneous types or attributes absent from both the schema and first page fail rather than silently dropping metadata.

## Filtering and inspection

- Rules combine with **AND**. Numeric and date ranges use `≥`, `≤`, `>` and `<`; add two rules for a range.
- Dates accept ISO 8601. Use a `Z` or explicit offset for unambiguous timezones. Displayed date metadata is normalized to UTC.
- Text uses case-sensitive equality, inequality, substring matching or lexical comparison. Boolean values accept `true`/`false` or `1`/`0`.
- Null values match only `is null` / `not null`, and are excluded from other comparisons. No free-form expression evaluation or SQL/CQL execution occurs.
- Text rules are evaluated against dictionaries once; numeric/date rules scan typed columns in the worker. Long scans yield to accept superseding filters. Only matching point indices cross back to the main thread; geometry is never rebuilt.
- Double-click performs one GPU picking pass into a **9 × 9 pixel** ID framebuffer, followed by a worker metadata lookup. Overlapping points select one rendered point; there is no overlap browser or hover handler. Standard double-click zoom is disabled.
- Filtering is enabled only after a successful completed load. Cancel terminates the ingestion worker and frees the dataset's GPU resources.

## Rendering and memory

The renderer uses opaque GL_POINTS and split high/low float Mercator coordinates. Subtracting the map center before adding low parts preserves subpixel accuracy at high zoom. The map is north-up, flat Web Mercator with pitch and rotation disabled; this intentionally keeps the custom projection simple and predictable. It supports normal smooth map pan/zoom gestures, not globe or 3D terrain.

Every WFS page also has a spatial index of at most 1,024 groups with actual coordinate bounds. Unfiltered, zoomed-in views skip offscreen groups and merge adjacent draw ranges. Wide views draw the full point index in one call. Filtered views draw only matching point indices; filtered index buffers currently do not receive a second spatial index. GPU context restoration rebuilds buffers from retained compact arrays without downloading WFS again.

GPU geometry plus spatial indices costs **20 bytes per allocated point**: 60 MB for 3 million points. Filters add up to 4 bytes per matched point. The main thread retains equivalent compact geometry/index arrays for context restoration, and the worker keeps numeric/date/boolean columns, string dictionaries, coordinates and IDs. Overall RAM is substantially larger than GPU memory, particularly with unique text attributes. Page parsing also temporarily creates GeoJSON objects. Counts alone cannot predict memory use for arbitrary metadata.

## Measurements and honest limits

Use **Run pan / zoom test**, then **Download metrics** on the computer that will run the application. Metrics include first points, full load, page count, uncompressed feature bytes, worker parsing/packing time, filter latency, GPU buffer bytes, renderer identity, and median/p95/max animation frame intervals. Frame intervals are end-to-end browser observations, not GPU timer queries or a guarantee of display refresh rate. An idle map is not continuously repainted.

Measured on 2026-10-02 (software GPU; values are a reproducible example, not a hardware guarantee):

| Measurement | Result |
| --- | --- |
| Loaded features | 3,000,000 of 3,000,000, across 60 WFS pages |
| First points available | 0.52 s |
| Complete WFS load | 22.51 s |
| Three-attribute filter | 156 ms; 249,379 matches |
| Uncompressed GeoJSON | 868,295,113 bytes |
| Geometry + spatial index GPU allocation | 60,000,000 bytes |
| Whole-dataset pan/zoom p95 frame interval | 1,072 ms — substantial stutter |
| Pan/zoom observed duration | 7.89 s for nominal 6 s animation |
| Unit/API and browser tests | 8 + 4 passed |

The archived `benchmarks/3000000-software-gpu.json` records a genuine 3 million-point WFS run in headless Chromium using **ANGLE SwiftShader software rendering**, at 1110 × 900 map pixels and 2 CSS-pixel points. It verifies every point loaded and no browser errors. The software GPU exhibited severe whole-dataset pan/zoom stalls. This prototype therefore **does not establish perfectly smooth rendering of all 3 million visible points**. A hardware-GPU benchmark is still required. Do not interpret a near-16 ms median as smoothness when p95 and maximum frame times show stalls.

Millions of raw WFS features also impose transfer costs: the 3-million-point fixture produces approximately 868 MB of uncompressed GeoJSON, although it is gzip-compressed in transit. First points appear progressively; getting every feature and all metadata is a bulk transfer, not an instantaneous operation. Real server/database throughput, bandwidth, attribute cardinality, display size, point density, browser limits and GPU determine the result.

For a hard smoothness requirement on weak GPUs or tens of millions of visible points, the next engineering step is a server-side spatial/tile index and cached raster/aggregation or another level-of-detail strategy. Those approaches change the literal “draw every individual point every frame” requirement. This app deliberately preserves all loaded points and measures that cost.

## Tests and repeatable benchmark

```sh
npm test
npx playwright install chromium
npm run test:browser
node scripts/benchmark.mjs 3000000
```

The benchmark script starts its own server, runs a three-attribute filter, resets to all points, measures pan/zoom, and writes metrics plus a screenshot. It forces software rendering for repeatable CI measurements. For hardware performance, open the page normally with hardware acceleration enabled and use the in-app test.

Tests cover column/date/boolean/null filtering, cancellation of superseded scans, duplicate IDs, XML/GML decoding and axis order, server pagination and validation, high-zoom coordinate precision, spatial-index membership, double-click metadata identity, GML loading, visible truncation and resource clearing. GitHub Actions runs build, unit/API and browser tests.

## Source guide

| File | Role |
| --- | --- |
| `src/main.ts` | MapLibre map, connection/filter controls, metadata popup, metric collection |
| `src/points-layer.ts` | GPU buffers, spatial culling, point drawing, double-click picking |
| `src/worker.ts` | WFS paging, lookahead requests, decoding, filter and metadata messages |
| `src/store.ts` | Typed metadata columns, dictionaries, filtering and duplicate detection |
| `src/data.ts` | GeoJSON/GML adapter, coordinate packing and page spatial indices |
| `server/server.ts` | WFS development fixture and built-app hosting; Node built-ins only |
| `server/demo.ts` | Deterministic point generator with eight metadata fields |
| `scripts/vendor.mjs` | Integrity cache and third-party notice collection |

The application source is MIT-licensed. Dependencies keep their own licenses; copies are in `vendor/licenses/`, with exact versions and integrities in `vendor/manifest.json` and `package-lock.json`.
