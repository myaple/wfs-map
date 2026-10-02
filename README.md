# WFS analysis workspace

A TypeScript analysis page for million-point WFS datasets. MapLibre renders every loaded point through a custom WebGL 2 layer. A worker holds typed metadata columns and calculates exact chart counts and nested AND/OR selections. Binned charts use bounded canvas aggregates; unbinned scatter plots draw contiguous point buffers with WebGL without per-observation JavaScript objects. There is no sampling, clustering, DOM map markers, or map hover picking.

## Build and run offline

Requires **Node.js 22.18+ or 24+**, Linux x64 for the vendored build toolchain, and `tar`:

```sh
npm run install:offline
npm run build
npm start
```

Open **http://127.0.0.1:8787** and click **Load enabled sources**. The default development source generates three million points. `/?points=3000000&autoload=1` starts loading automatically.

All npm dependencies, including native Linux x64 build packages, are committed in `vendor/npm-cache-parts/`, with licenses and exact versions in `vendor/licenses/`, `vendor/manifest.json`, and `package-lock.json`. The install script assembles the committed binary parts, checks their SHA-256, extracts the integrity-checked cache and invokes `npm ci --offline`; it does not contact an npm registry. Builds produce self-contained `dist/` assets, including both workers and MapLibre CSS. Once built, `node server/server.ts` uses only Node built-ins; no npm install, CDN, database, or API key is needed to run it.

The default grid basemap works offline. On Data sources, configure an optional HTTP(S) XYZ raster tile URL containing `{z}`, `{x}` and `{y}`, plus attribution. Relative local tile URLs work offline when those tiles are hosted locally. The Basemap switch and URL are saved in this browser; an empty URL keeps the grid. OpenStreetMap is the initial optional tile provider. Connecting a remote WFS naturally requires access to that server.

Development: `npm run dev` starts Vite on port 5173 and the WFS fixture on 8787, with a same-origin proxy. On a different build platform, install once online and run `npm run vendor` to prepare that platform's npm cache bundle. Node itself and optional browser-test Chromium binaries are not vendored.

### Container build

```sh
docker build --pull=false --network=none -t wfs-map .
docker run --rm -p 8787:8787 wfs-map
```

Preload the `node:24-bookworm-slim` base image before an entirely disconnected Docker build. The Dockerfile also disables networking on the dependency-install and build steps. Its runtime stage contains only `dist/` and the development server. The vendored archive targets Linux amd64; select that platform if building on ARM. Docker was unavailable in the development environment, so the image build itself has not been executed; an independent clean-directory install, TypeScript/Vite build and unit/API tests passed using the same offline commands.

## Analysis page

WFS configuration lives on the **Data sources** subpage (`#configuration`). Add, name, configure and enable up to eight independent WFS sources; each can select its own endpoint, feature type, paging settings and development fixture size/distribution. More than one source can be enabled simultaneously. Source names, settings, colors and enable switches are saved in this browser.

Click **Load enabled sources** to load the enabled set. Each source has its own worker, column store, GPU layer and color. The **Analyze source** selector switches the filters and charts to that source while every enabled source remains on the shared map. Chart layouts, manual rules, nested groups and chart selections stay separate and survive switching. Filters never propagate to another server, even when feature IDs or attribute names overlap. Double-click metadata identifies the source as well as the feature.

At most two sources load concurrently; additional enabled sources wait in a queue. A source failure leaves other sources available. Disabling a source cancels its requests, terminates its worker, and releases its geometry/GPU buffers. Re-enabling reloads it and reapplies its analysis settings if the schema is unchanged. **Reload this source** applies edited connection settings; a changed schema resets that source's incompatible charts and filters. Clearing datasets keeps their small analysis settings. Source configs persist across browser reloads; filters and chart layouts persist only for the current page session.

Charts are populated from DescribeFeatureType or the adapter's inferred schema. Initial charts choose categorical, date and numeric attributes when available. Add, remove, or reconfigure up to **12 charts**:

| Type | Attributes | Display and selection |
| --- | --- | --- |
| Bar | Any primitive attribute | Category counts or numeric/date histogram; click a bar |
| Pie | Any primitive attribute | Category counts or histogram; click a slice |
| Time series | Date X; optional numeric Y | Count, sum, mean, minimum or maximum by time interval; click a segment |
| Scatter | Two number/date attributes | Counted 2D bins, or every individual observation with binning off; click or right-drag a rectangle |

Bar, pie and time-series charts always aggregate the full selection into bounded categories or bins. Only scatter plots have a **Binning off** option, which draws **every non-null observation** with WebGL. There is no sampling or distinct-value cap for raw scatter; it retains original row IDs for point clicks, and overlapping dots return one observation. Numeric/time charts have 8–64 configurable bins. Time-series **Y aggregation** selects count, sum, mean, min or max; the latter four enable a numeric **Y attribute** selector. Null Y values are excluded and counted as missing. Full-data domains and bin boundaries remain stable through filtering. Numeric ranges include the lower bound, exclude the upper bound, and include the maximum in the last bin. Millisecond time boundaries use exact integer edges.

Every chart uses the same mouse gestures: **left-drag a rectangle to zoom**, **right-drag to select**, and **double left-click to reset zoom**. Zoom only changes the local viewport; it does not filter the dataset, issue WFS requests or upload point data again. Single segment/point clicks and keyboard selection still filter. Scatter axes have numeric/date value ticks, axis titles, gridlines and readable UTC dates/times that adapt to the zoom level. Canvas and WebGL geometry use the same actual plot dimensions, including enlargement. Binned scatter selection chooses cells intersected by the range; raw scatter selection uses exact numeric/date bounds. Pie rectangle selection intersects its sectors.

Use **Enlarge** on any chart for a large modal view. **Return to normal size** or Escape restores the original position and size while retaining the zoom and source selection. Raw scatter supports arrow keys to step through original observations; Enter selects one.

Category charts retain the 23 most frequent categories from the full dataset and an exact **Other categories** segment when needed. Clicking Other matches every remaining non-null category. Missing attributes are excluded from plotted counts and reported separately. Plotted counts plus missing counts equal the current selection. Counts and keyboard selection are available in each chart's disclosure; focus a plot, use arrow keys, and press Enter to select a bin. Hovering a binned chart reads only its bounded aggregate counts and never queries individual map features.

Choose **Point colour** for the active source to colour by an attribute. Numbers and dates use 8, 24 or 64 fixed full-data value bins across configurable low/high colours; text uses the top categories and Other, and booleans use false/true. The legend shows the domain and gradient; nulls are grey. Each source saves its attribute, bin count and ramp separately. Colour bins stay stable through filtering. Palette edits change uniforms without rescanning attributes or uploading point geometry. Choose Source colour to return to the source’s solid colour.

### Combined filters

Each filter group can use **AND** or **OR**, and groups can contain other groups. Use **Add chart selections here** to choose the receiving group; the highlighted group is the active target. Chart selections apply immediately. **Right-click and drag a box on the map** to add a geographic selection for the active source to the highlighted group. Its inclusive longitude/latitude bounds combine with other predicates through the same AND/OR engine; removing the selection or clearing filters restores those rows. Manual rules and changed group operators apply with **Apply filters**. Removing a condition or clearing filters also updates the selection.

For example, create an AND root containing an OR group for `category = sensor` or `category = vehicle`, plus `value ≥ 50` and `timestamp ≥ 2025-01-01T00:00:00Z`. Range selections and scatter rectangles are nested AND expressions, so their endpoints remain together even inside an OR group. Repeated matching branches never duplicate features or counts.

A source’s charts and map layer use the **same complete-dataset selection**. The shared map displays the independently filtered layers of all enabled sources. Panning does not recompute chart counts. Empty AND groups match all rows; empty OR groups match none. Expressions support up to 128 nodes and 8 levels of nesting, with visible errors for excess complexity.

Numeric/date rules support equality, inequality and ranges. Dates accept ISO 8601; use `Z` or an explicit offset. Displayed dates are UTC. Text comparisons are case sensitive, including substring and lexical comparisons. Booleans accept `true`/`false` or `1`/`0`. Nulls match `is null` / `not null` and do not match ordinary comparisons, including inequality. There is no arbitrary JavaScript, SQL or CQL expression execution. Filters become available after a completed load; they run locally rather than issuing WFS queries.

Double-click a map point for metadata. Picking checks enabled layers from top to bottom with 9×9-pixel GPU ID passes until it finds a hit, then requests metadata from that source’s worker. Overlapping points return one hit. There is no map hover handler or overlap list. Cancel/clear terminates all source workers and frees their dataset buffers.

## Data source compatibility

1. On **Data sources**, choose the source to edit and enter the WFS URL. Vendor parameters and URL tokens are preserved.
2. Choose a WFS version, **Discover layers**, and select a feature type.
3. Set the exact advertised output format. Prefer `application/json`; simple GML Point output also works.
4. Request `urn:ogc:def:crs:OGC:1.3:CRS84` for longitude/latitude. EPSG:4326 GML may require reversing the configured axis order. GeoJSON always uses longitude/latitude.
5. Choose a stable unique sort attribute if necessary. Keep the dataset unchanged throughout loading.
6. Load, then analyze attributes and inspect points.

The adapter uses GetCapabilities, DescribeFeatureType, GetFeature hits and bounded paged GetFeature requests. One-page lookahead overlaps transfer with packing. Unknown totals load until an empty page or the explicit client limit. Server page caps are supported. The fixture serves up to 50 million deterministic points with eight fields: `id`, `category`, `status`, `value`, `timestamp`, `active`, `source`, `quality`. It supports UK, world and dense distributions, generates only requested pages, and does not allocate the full dataset on the server.

Supported scope: **WFS 2.0 paging**, GeoJSON FeatureCollections or simple GML 2/3 Point members using `pos`/`coordinates`, primitive attributes, geographic coordinates within Web Mercator's ±85.05112878° latitude limit. WFS 1.x requires the server's `startIndex` paging extension. MultiPoint, polygons, curves, geometry references, archives, and arbitrary projected CRS decoding are unsupported.

CORS must permit the browser origin, or serve behind a same-origin reverse proxy. Authentication supports same-origin cookies or endpoint URL tokens; custom authorization headers, OAuth UI and cross-origin cookie flows are not implemented. There is no unrestricted backend URL-fetching proxy.

Repeated IDs/pages, changed counts, premature empty pages, ignored page sizes, invalid geometry/coordinates and unexpected schema changes fail visibly. They cannot prove snapshot consistency when counts are stable but rows change or IDs are absent. Stable pagination and snapshot isolation remain server responsibilities. Client-limit truncation is explicitly reported; charts then describe only the loaded subset.

## Performance and memory design

- Ingestion drops page feature objects after packing metadata into per-page **contiguous Float64/Int32 columns**. String attributes use dictionary codes. Coordinates and original IDs remain available for metadata inspection.
- Filters compile a small expression tree into reusable **32,768-row Uint8 masks**. Each leaf scans its column; AND/OR combines masks. No expression traversal, object construction or string comparison happens per matching feature. Text comparisons evaluate dictionary entries once and use code lookups per row.
- Numeric domains and category rankings are cached per attribute in each source’s worker. Category-to-bin tables and Uint32 bin counts are compact. Filtering and all chart aggregations share each block's selection mask. The worker yields between blocks, accepts superseding requests, and suppresses stale results.
- Matching Uint32 map indices and bounded chart aggregates cross to the UI by transferable buffers. In unbinned scatter mode the worker also sends normalized interleaved Float32 coordinates and original Uint32 row IDs, without creating point objects. Canvas charts draw at most 4,096 scatter cells; raw scatter makes one GPU draw over all observations. Inactive raw chart GPU contexts are released and recreated from retained typed data on source switching. Geometry is never rebuilt for filters. There is no new dependency.
- Geographic leaves scan the existing contiguous longitude/latitude columns. Attribute colour calculation yields compact Uint8 bin codes; the map shader reads a shared 64-colour uniform palette. Colour requests have a separate cancellation revision so changing chart filters does not recompute colour data.
- Every WFS page has a 32×32 spatial index with actual bounds. Unfiltered zoomed views skip offscreen groups; wide views draw the full index. Filtered views draw only matches but currently do not have a second spatial index. GPU restoration uses retained compact arrays.

GPU geometry plus spatial indices uses **20 bytes per allocated point** (60 MB at three million), plus 4 bytes per displayed filtered point. Attribute colouring adds **1 GPU byte per loaded point** plus an equivalent retained Uint8 array. Unbinned scatter adds **12 bytes per numeric plotted observation** in the UI (8-byte normalized coordinates, 4-byte original row ID) and 8 GPU bytes per observation, per chart. Date scatter uses split-float coordinates to preserve close timestamps under deep zoom: 20 CPU bytes and 16 GPU bytes per plotted observation; each calculation temporarily reserves up to 12 bytes per loaded point (20 for date scatter) in the worker. Small filtered outputs are copied into tight buffers before transfer. Context recovery retains equivalent main-thread geometry arrays. The worker retains typed columns, coordinates, string dictionaries and original ID strings. A filtered output reserves up to 4 bytes per loaded point before exposing its matching subarray. Filter masks cost 32 KiB per expression node (up to 4 MiB). Categorical profiling temporarily uses 4 bytes per distinct value; categorical bin maps use 1 byte per distinct value per chart. These costs, unique strings/IDs and transient GeoJSON pages mean total RAM is substantially larger than GPU buffers. Costs add across enabled sources; source limits are per source, not a global memory budget. This is not an out-of-core engine.

The map is north-up flat Web Mercator, with rotation, pitch, globe and terrain disabled. Downloading millions of raw WFS features remains a large bulk transfer. Full-density map smoothness remains dependent on hardware and is **not established** by fast worker filtering.

## Measured results

The reproducible **three-million-point workspace** run used headless Chromium with ANGLE SwiftShader, a software GPU:

| Measurement | Result |
| --- | --- |
| Complete WFS load | 23.79 s; all 3,000,000 features loaded |
| First points | 0.501 s |
| Initial three-chart calculation, including uncached profiles | 302.2 ms in worker |
| Nested AND/OR filter + all three chart updates, five runs | 170.7–230.8 ms; median 172.9 ms in worker |
| Matching points | 500,040; each chart accounts for every match |
| Reset to all points + chart updates | 295.3 ms in worker |
| Filter browser round trips | 0.50–2.59 s, including automation polling and GPU upload |
| Browser errors | None |
| Original workspace correctness tests | 14 unit/API + 12 browser tests passed |

See `benchmarks/3000000-analysis-workspace.json` and its screenshot. Worker timings include filter scans and aggregation, not GPU rendering. Browser round trips reflect substantial software-renderer costs and must not be presented as sub-250-ms visible updates.

The simultaneous-source run (`benchmarks/3000000-multi-source.json`) loaded **two 1.5-million-point sources** and calculated three charts for each in 16.50 s overall. Independent two-attribute filters plus chart updates took **70.8 ms** and **75.5 ms** in their respective workers. The combined browser selection response was 110.2 ms, including buffer uploads and automation but without waiting for the next map paint. Results matched independently calculated fixture counts: 187,366 and 76,840; no browser errors. These results are from the same software renderer, with different filters and point distributions from the single-source run; they are not hardware smoothness measurements.

The controls benchmark (`benchmarks/3000000-controls.json`, reproducible with `node scripts/benchmark-controls.mjs 3000000`) loaded all **3,000,000** points in **22.29 s** and drew every observation in an unbinned scatter plot while calculating a mean-quality time series. The raw-chart calculation took **253.2 ms** in the worker; coordinates and IDs occupied 24 MB and 12 MB. Numeric map colour codes occupied **3 MB**. A geographic selection matched an independent fixture count of **667,181** points and updated all three charts in **174.6 ms** in the worker (198.6 ms browser response including automation/uploads, without waiting for map paint). No browser errors. This used SwiftShader and does not establish hardware-GPU frame smoothness.

The date-scatter variant (`benchmarks/3000000-date-controls.json`, reproducible with `node scripts/benchmark-controls.mjs 3000000 date`) loaded **3,000,000** points in **22.84 s**. Raw date scatter plus mean-quality time-series calculation took **328.5 ms** in the worker, with 48 MB of split-float coordinates and 12 MB of IDs. Geographic selection matched the same **667,181** points and updated the charts in **226.2 ms** in the worker (245.8 ms browser response without waiting for map paint). No browser errors; this also used SwiftShader.

The earlier prototype benchmark remains archived in `benchmarks/3000000-software-gpu.json`: it loaded three million features in 22.51 s but had a **1,072-ms whole-dataset pan/zoom p95**. That run used a different layout and simpler AND filter. Neither run proves smooth rendering of three million simultaneously visible points on a hardware GPU. The fixture produces about 868 MB of uncompressed GeoJSON at that size, gzip-compressed in transit. Real network/server throughput and attribute cardinality change these results. Weak GPUs or much larger visible datasets may need a different rendering/level-of-detail strategy.

## Verification

```sh
npm test
# Browser testing needs an installed Chromium (download separately if needed).
npx playwright install chromium
npm run test:browser
npm run benchmark:analysis -- 3000000
npm run benchmark:sources -- 1500000
node scripts/benchmark-controls.mjs 3000000
node scripts/benchmark-controls.mjs 3000000 date
node scripts/preview-charts.mjs
node scripts/benchmark.mjs 3000000
```

Current validation: **18 unit/API tests and 22 browser tests pass**, along with a fresh offline vendored install/build/test in an independent directory. Tests cover custom local basemap templates and persistence, time Y aggregation, scatter-only unbinned mode, exact-point picking and rectangle selection, geographic edge/antimeridian predicates, source-specific colour/box state, colour code memory and stable bins, and bounded non-scatter aggregation. Chart navigation tests cover canvas/WebGL zoom and reset without dataset changes, right-drag selection (including pie/time), date axes and millisecond precision across multi-year domains, modal enlargement/restoration, Escape, type switching, and removing an enlarged chart.

Analysis tests independently check nested expression semantics, missing values, constants, Other categories, chart totals, exact clicked bin membership, fractional time boundaries, cancellation and invalid schemas. Browser tests exercise schema-driven chart types, pie clicks, scatter dragging, OR chart selections, nested manual rules, keyboard selection, latest-request wins, multi-source isolation, distinct schemas, persistence, disable/re-enable, source-aware picking, partial failure, subpage navigation, GML, high-zoom picking and truncation. CI installs npm dependencies from the committed offline bundle; browser binaries are fetched separately for tests.

The analysis benchmark writes worker and browser round-trip timings plus a screenshot. The original benchmark tests pan/zoom; in-app **Performance measurements** also exports runtime metrics for hardware testing.

| File | Role |
| --- | --- |
| `src/analysis.ts` | Nested column-mask filtering, cached profiles and exact chart aggregation |
| `src/workspace.ts` | Filter groups, chart configuration, canvas plots, click/brush/keyboard selection |
| `src/main.ts` | MapLibre, configuration subpage, worker coordination, metadata and metrics |
| `src/store.ts` | Typed metadata columns, dictionaries and duplicate detection |
| `src/points-layer.ts` | GPU buffers, culling, rendering and double-click picking |
| `src/chart-plot.ts` | Shared chart axes, local viewport, pointer gestures and bounded pie-sector intersection |
| `src/raw-scatter.ts` | Unbinned WebGL charts, original-row picking, numeric/date brushing, readable axes and context recovery |
| `src/worker.ts` | WFS ingestion, analysis revisions and transferable results |
| `src/data.ts` | WFS decoding, schema types and coordinate packing |
| `server/` | Deterministic WFS fixture and built-app hosting, using Node built-ins |
| `scripts/install-offline.mjs` | Restore and install the committed integrity cache |

Application source is MIT-licensed. Dependencies retain their own licenses and exact lockfile versions.
