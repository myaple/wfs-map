# WFS analysis workspace

A TypeScript analysis page for million-point WFS datasets. MapLibre renders every loaded point through a custom WebGL 2 layer. A worker holds typed metadata columns and calculates exact chart counts and nested AND/OR selections. Binned charts use bounded canvas aggregates; unbinned scatter plots draw contiguous point buffers with WebGL without per-observation JavaScript objects. There is no sampling, clustering, DOM map markers, or map hover picking.

## Named analyses and workstation-only data

The landing page lists **My analyses** for the authenticated user. Create a named analysis, open its Analysis or Data sources page, or open several analyses in separate tabs. **Save analysis** stores the complete configuration remotely: source connections, CSV file name/reference and column mappings, column names/types, nested filters, chart specifications, colours, basemap, map view and time/area choices. Source **Save changes** first applies edits and persists CSV files locally; then use **Save analysis** to update the remote setup. Unsaved analysis edits remain in the current tab. An optional creation checkbox imports the browser's previous sources/map into a new named analysis.

**Share** saves the configuration and creates a live read-only link. Recipients authenticate through the same gateway, connect directly to WFS services, and attach their own local CSVs through Data sources → Configure. Saved column mappings and filters survive attachment; required column names are checked and filter/chart restoration also checks their inferred types. A filename alone does not establish that two CSVs contain the same data. The local attachment survives reload without changing the owner's configuration. **Save a copy** creates the recipient's own editable analysis; **Stop sharing** revokes the link. Links can be opened by any authenticated holder, so this first version has no team directory or recipient ACL.

Different analyses use separate browser settings and in-memory state. Two tabs editing the same analysis can work independently, but a stale **Save analysis** returns a conflict and offers reopening or saving a copy instead of overwriting another tab's changes. CSV blobs remain in IndexedDB, in a separate database for each authenticated user, and are retained for that user's other analyses/copies. A shared reference never resolves a different user's file in the same browser profile. Authenticated analyses do not automatically read the older, unscoped local cache; reattach those files through Data sources. Clearing browser storage removes local files; the remote setup then prompts for reattachment. Browser storage is local application state, not an OS security boundary between people who control the same browser profile.

Relative time choices (for example Last 24 hours) resolve against the current time when reopened, making daily reuse useful. Custom time ranges and the geographic request box restore exactly. Saved filter values and categorical colour overrides are configuration and can themselves contain sensitive literals; they are part of the remote metadata explicitly selected for saving. Individual scatter-observation selections refer to row indices in one local load. **Save analysis**, **Share** and **Save a copy** refuse a setup containing those selections and explain which selection chips to remove; all current filters and the saved configuration remain intact. Attribute/range/chart-bin filters retain their exact nested AND/OR semantics when saved.

The browser uses an explicit configuration serializer; the API independently validates a bounded allowlist and rejects raw CSV text, rows, features, results and runtime metrics. Dataset retrieval, parsing, filtering, chart aggregation, metadata inspection and CSV export all execute on the workstation. The Rust API serves static assets and saves JSON configuration in PostgreSQL; it never fetches WFS/tile URLs or accepts file uploads. The existing `.tar.gz` backup feature remains a **local full-data export** containing CSV contents; downloading or importing that archive does not send it to the configuration API.

## Trusted gateway identity

mTLS terminates **before the API**, at your existing authentication gateway. Set **`USER_ID_HEADER`** to the HTTP header containing its stable user ID (default `x-user-id`). With the default `AUTH_MODE=proxy`, the API trusts that header alone and rejects a missing, empty or invalid ID with HTTP 401. It does not inspect certificates or require an additional certificate-verification header. IDs determine ownership; no separate password/login flow or user registration is needed. Renaming an upstream identity changes which analyses it owns.

The gateway must overwrite the configured identity header with its authenticated identity on every forwarded request, removing client-supplied values. Keep the API reachable only from that gateway. `deploy/compose.yml` publishes no API/database port and creates the internal `wfs-workspaces-private` network; attach the existing gateway to it and forward to `api:8787`. `deploy/nginx.conf.example` illustrates overwriting the identity header if your terminator is nginx; adapt it to your own stable identity claim/header. The browser and API should share one origin. API responses are not cached, and mutations require the browser's `X-Workspace-Request: 1` header without allowing cross-origin requests. Avoid logging request bodies or share-link query strings in your gateway.

| Variable | Default / purpose |
| --- | --- |
| `DATABASE_URL` | Required PostgreSQL/PostGIS connection URI |
| `USER_ID_HEADER` | `x-user-id`; trusted upstream user identity header |
| `AUTH_MODE` | `proxy`; explicit `development` bypass for local work only |
| `DEV_USER` | `local-analyst` in development mode; request headers are ignored |
| `BIND` | `127.0.0.1:8787` outside Docker; image uses `0.0.0.0:8787` |
| `ASSET_DIR` | `dist`; image uses `/app/dist` |
| `PAGE_BANNER_TEXT` | Empty by default (banners hidden); the same plain, single-line text in the header and footer on every base page |
| `PAGE_BANNER_BACKGROUND` | `#eaf0f4`; the same CSS background colour for both banners |

Set these runtime variables on the application process, or in the Compose `.env` file, then restart/recreate the application container. No image rebuild is needed. For example:

```dotenv
PAGE_BANNER_TEXT="Internal use only"
PAGE_BANNER_BACKGROUND="#ffdf80"
```

The banners use the normal page font and stay at the top and bottom of the base viewport, including the analysis picker, data sources, saved/shared/local analyses and analysis-opening errors. Text is rendered literally, and line breaks become spaces. Long text stays on one line and can scroll horizontally; choose a short label and a background that contrasts with the dark text. Modals and enlarged maps/charts can cover the banners. Empty text hides both. `GET /api/site-config` returns only these public display settings with caching disabled; it requires no identity header so banners also appear on authentication errors. The Node host supports the same variables for `npm start` and `npm run dev`.

The backend uses Rust **Poem**, **poem-openapi**, **Diesel** and a connection pool. Startup applies embedded migrations and enables PostGIS; the initial table contains configuration JSONB, ownership, revisions and revocable share tokens. No feature geometry/data is stored in PostGIS. The migration role must be allowed to enable the PostGIS extension (or have it enabled in advance). `GET /api/openapi.json` exposes the generated API specification behind the identity header; `GET /health` is a public liveness endpoint.

## Kubernetes deployment

Use the configurable [Helm chart](charts/wfs-map/README.md) in
`charts/wfs-map`. It deploys the combined production UI/API image with a
Service and optional Ingress. PostgreSQL/PostGIS is external only: point at
an existing connection Secret, including CNPG's generated `uri` Secret.
There is no embedded database or chart dependency. Values cover security
contexts, volumes, environment, sidecars, probes, scheduling, HPA, PDB,
NetworkPolicy and templated `extraResources` for CNPG or other manifests.

## Build and run offline

Requires Node.js **22.18+ or 24+**, Rust **1.90**, Linux x64, a C compiler/Make/Perl for bundled libpq/OpenSSL, `tar`, and an available PostgreSQL/PostGIS database:

```sh
npm run install:offline
npm run install:rust-offline
npm run build
cargo build --manifest-path backend/Cargo.toml --release --locked --offline
DATABASE_URL=postgres://wfs:password@127.0.0.1:5432/wfs \
  AUTH_MODE=development ./backend/target/release/wfs-workspaces
```

Open **http://127.0.0.1:8787** to select/create an analysis. Production uses `AUTH_MODE=proxy` and the trusted gateway described above. For local frontend development, run `npm run dev` (Vite 5173 and generated WFS fixture 8787), and separately run `BIND=127.0.0.1:8788 AUTH_MODE=development DATABASE_URL=… npm run start:api`. Vite proxies `/api` to the Rust service on 8788. The Node static/fixture host remains available with `npm start`; its local-analysis shortcut is `/?local=1&time=all`, and it does not implement persistent analysis endpoints.

All npm dependencies are committed in `vendor/npm-cache-parts/`, with licenses/versions in `vendor/licenses/`, `vendor/manifest.json` and `package-lock.json`. All Rust crate sources and licenses, including libpq/OpenSSL, are committed in `backend/vendor-parts/` with a SHA-256 manifest tied to `backend/Cargo.lock`. Install scripts verify/unpack these bundles; npm installation and Cargo compilation use offline mode. Runtime assets include both workers and MapLibre CSS with no CDN or package-registry dependency. To update dependencies on a connected build machine, regenerate with `npm run vendor` and `npm run vendor:rust`. Toolchains, Docker base images and test Chromium are supplied separately.

The default grid basemap works offline. Configure an optional local/intranet XYZ tile URL containing `{z}`, `{x}` and `{y}`, plus attribution, in Data sources. An empty URL keeps the grid. The browser needs access to its configured WFS and tile services; the API/database need no Internet access.

### Disconnected Docker deployment

The **Publish container** workflow builds/pushes `ghcr.io/myaple/wfs-map:sha-<first seven SHA characters>` on every push; `main` also publishes `latest`. PRs build/test without publishing. Images target Linux amd64. Prepare images on a connected machine, then transfer the archive into the disconnected environment:

```sh
docker pull ghcr.io/myaple/wfs-map:latest
docker pull postgis/postgis:16-3.4
docker save -o wfs-images.tar ghcr.io/myaple/wfs-map:latest postgis/postgis:16-3.4
# On the disconnected host:
docker load -i wfs-images.tar
POSTGRES_PASSWORD=your-url-safe-password USER_ID_HEADER=x-analyst-id \
  docker compose -f deploy/compose.yml up -d --pull never
```

Use a commit-SHA application tag and pin the database image digest for controlled releases. Compose has `pull_policy: never`, a persistent database volume and an internal network. Connect your existing mTLS gateway to `wfs-workspaces-private`. The application image contains the Rust binary and built UI, runs as an unprivileged user, performs no startup downloads and needs only its database connection. PostGIS is a separate preloaded service. Back up the configuration database/volume according to your deployment procedures; no CSV file recovery is possible from it.

For Kubernetes, the same production image also contains the **complete Helm
chart** at `/app/charts/wfs-map`: templates, values, JSON schema, deployment
examples and documentation. [Extract it from a stopped container](charts/wfs-map/README.md#extract-from-the-application-image)
using `docker create` and `docker cp`, then deploy with Helm. The chart has no
dependencies, so transferring the image also transfers the entire chart.

For a fully disconnected **image build**, preload `node:24-bookworm-slim`, `rust:1.90-bookworm` and `debian:bookworm-slim`:

```sh
docker build --pull=false --network=none -t wfs-map .
```

Every Dockerfile install/compile step explicitly uses `--network=none`; dependencies come from the repository bundles. CI runs the real API ownership/revision/share tests against PostGIS, then starts the built application plus PostGIS on an internal Docker network to verify static assets, the custom identity header and migrations without Internet access.

### Local full-stack testing

`deploy/compose.e2e.yml` runs the frontend (nginx and the built UI), Rust API, PostGIS and a normal generated WFS service as separate containers. Only the frontend publishes a port, on **127.0.0.1:8787**. It injects `X-E2E-User` and the API runs in normal proxy-auth mode with that header configured. This is a local test gateway that impersonates **alice** by default, without mTLS. Open `/__test/user/bob` or `/__test/user/alice` to switch identities; `/__test/user/none` tests missing authentication. The gateway overwrites incoming identity headers. Use `deploy/compose.yml` with your real mTLS gateway for deployment.

Preload the base/database images on a connected machine (transfer them with `docker save`/`docker load` for disconnected testing):

```sh
docker pull node:24-bookworm-slim
docker pull rust:1.90-bookworm
docker pull debian:bookworm-slim
docker pull postgis/postgis:16-3.4
docker pull nginx:1.28-alpine
# Only needed for the containerized browser-test runner:
docker pull mcr.microsoft.com/playwright:v1.56.1-noble
```

Start the stack for manual testing:

```sh
docker compose -f deploy/compose.e2e.yml up -d --build --wait
# Open http://127.0.0.1:8787
# Optional: WFS_E2E_PORT=18787 to use another local port.
```

Run the real-stack browser/API regressions against that stack:

```sh
docker compose -f deploy/compose.e2e.yml --profile tests run --build --rm tests
```

Or build, start, test and clean up a new disposable stack in one command:

```sh
npm run test:e2e:docker
```

The runner bundles its Chromium binary and installs npm dependencies offline. The suite does not mock the workspace API: it covers header injection, private-analysis ownership, read-only sharing/revocation, simultaneous analysis tabs, revision conflicts, per-user local CSV attachment/copy/reload, absence of row uploads, and preservation of filters when a save is refused. Services and the runner use an internal Docker network; builds/install steps need no package-registry access after image preload. CI executes the same Compose suite against the application image it just built. Failure traces are written to `test-results/e2e`.

`docker compose -f deploy/compose.e2e.yml down` stops a manually started stack and retains its test database. Add `--volumes` to discard that test database. The one-command disposable runner cleans up only its own project and volume. If Playwright is already installed locally, `WFS_E2E_URL=http://127.0.0.1:8787 npm run test:e2e` runs the same suite without the runner container.

## Analysis page

WFS configuration lives on the **Data sources** subpage (`#configuration`). The list shows each source’s name, endpoint, feature type and enable checkbox. **Add data source** opens an empty, generic WFS editor; **Configure** opens the same editor for an existing source. Enter a feature type manually or use **Discover layers**, and expand **WFS compatibility and limits** for format, version, CRS, coordinate order, sort and paging options. Up to eight independent sources can be enabled simultaneously.

Choose **CSV file** in **Source type** to upload a CSV or TSV with unique column headers. Select comma, semicolon, or tab as its delimiter, then choose longitude/latitude columns or a WKT/GeoJSON Point geometry column. Coordinates must use WGS84 degrees: longitude −180 to 180 and latitude −90 to 90. For CSV and WFS points beyond ±85.051129° latitude, only map positions are clamped to the Web Mercator map edge; a load warning reports the affected count. Original coordinates remain available in records, charts, filters and exports. Geographic area filters use the original coordinates. An optional time column accepts ISO 8601 dates/times and becomes a date attribute for filters and charts; use **All time** for files without time. Quoted fields, escaped quotes, embedded newlines, CRLF and a UTF-8 BOM are supported. Numeric and boolean columns are inferred across the whole file; blank cells become null.

CSV import keeps valid rows and reports imported, rejected and time/map-excluded row counts in the load status. Rejection reasons include missing/invalid coordinates, invalid Point geometry, invalid timestamps, wrong column counts and malformed quoting. Each reason includes a count and up to five physical CSV line numbers (a multiline record is identified by its starting line). Blank optional metadata and times remain null in All time; a missing time is rejected when time bounds require it. Completely empty lines are ignored; delimiter-only records count as data rows and are validated. If every row is invalid, import fails with the complete rejection summary. Invalid headers and unterminated quoted fields stop import because record boundaries cannot be safely recovered. The original file remains intact for correcting mappings, reloading and backup.

CSV files use the same worker, map layers, per-source filters, charts, colouring and metadata as WFS. Shared time/area bounds select CSV rows locally; refreshing or clearing those bounds reloads from the original imported file. The file contents persist in IndexedDB with **Save changes**; compact settings and column mappings remain in localStorage. Files larger than the localStorage quota can be saved and loaded again. Available capacity depends on your browser and device: a failed save retains the previous sources and files for retry. Existing inline CSV files migrate when settings are saved, and saved replacement/removal releases the old file in standalone local mode. Named analyses retain files for reuse by copies and other tabs.

Uploading and configuring a CSV reads only its header. The original File/Blob is saved directly, without building a whole-file JavaScript string on the main thread. The source worker reads 1 MiB input chunks: one pass infers column types across the whole file and checks record structure, and a second converts and packs at most 25,000 features at a time. Scan progress is visible, and row rejection counts are reported after import. Temporary parsing memory stays bounded by the input chunk, current record and feature batch; loaded numeric columns and unique string dictionaries still need RAM proportional to the dataset. Files remain local to the browser.

The browser suite generates a 200,000,091-byte regression CSV with 2,000,000 rows, 16 columns, and two text columns containing a unique value in every row. It checks ingestion, original values, filtering, export and reload. To reproduce the memory/CPU profile separately:

```sh
npm run build
node scripts/csv-stress-fixture.mjs /tmp/wfs-csv-stress/2m-16cols.csv
npm run benchmark:csv -- /tmp/wfs-csv-stress/2m-16cols.csv /tmp/wfs-csv-stress/profile.json
```

The profiler writes process RSS samples, phase timings, main/worker CPU profiles, final heap/backing-storage sizes and a screenshot. See [the measured crash and fix](benchmarks/csv-2m-streaming.md). The large CSV is generated for the test instead of checked into Git.

**Backup & share** on Data sources provides **Download backup** and **Import backup**. A `.tar.gz` includes the current source list (including staged edits and disabled sources), complete original CSV contents and column mappings, WFS connection settings, source colours/category palettes, and map background, centre, zoom and point size. WFS features are not copied: recipients connect to the configured server when loading. A recipient must be able to reach those endpoints; relative WFS/tile URLs resolve against their app host. Backups are unencrypted and include endpoint query parameters as configured.

Import validates the archive and previews its source list. **Replace sources & restore** replaces and immediately saves the sources and map settings in the receiving browser; Cancel leaves the current set untouched. Fresh local CSV references prevent reuse of stale files, and validation/storage failures preserve the previous set. Dataset filters, chart configurations and session time/map-area bounds are not part of the archive; filters/charts reset on restore, and the receiving session's time/area bounds still apply. Map view and point size also persist between visits; a restored view stays in place when sources load, with **Fit dataset** available to frame the points.

The version-1 archive contains `manifest.json` (`format: "wfs-map-backup"`, `version: 1`, `settings`, `csvFiles`) and `csv/source-N.csv` entries encoded as UTF-8. It uses standard USTAR and gzip via the browser's Compression Streams API, without a new dependency. Import accepts only regular files with unique safe paths, valid headers and complete CSV references; unsupported versions, unexpected entries, corrupt/truncated archives and archives over 1 GiB uncompressed are rejected. The manifest is limited to 1 MiB. Automated unit and browser tests cover export/import round trips, sharing into a fresh browser, datasets beyond localStorage quota, reload, cancellation and failed storage writes.


**Add to list** / **Update source** stages the editor changes. **Remove** stages removal and offers **Undo remove**, including for the last source. **Save changes** saves CSV files in IndexedDB, then publishes the source list and map background together as compact metadata in localStorage. It applies additions/removals/settings and loads new or changed enabled sources. Until then, existing analysis keeps using the saved settings. **Discard changes** restores the saved list and background; Cancel or Escape dismisses an editor without changing the list. Unsaved changes and save failures are shown explicitly. Existing saved sources migrate automatically, retaining their names, IDs, enabled state, colours and connection settings. Generated fixture counts/distributions become normal URL query parameters. Analysis colour preferences continue to save immediately.

**Optional test WFS server** is separate from the source editor and collapsed by default. Starting it activates the built-in `/test-wfs` endpoint in the app’s Node server. **Add as data source** pre-fills the ordinary editor with its URL and feature type; it never adds a special source automatically. Point count and distribution are ordinary endpoint query parameters, so multiple test sources can use different datasets. The endpoint stays active until the Node server restarts; start it again from the panel after a restart. This requires the development Node host (or Vite’s same-origin proxy); the production Rust host does not provide generated WFS data and reports an actionable error. The legacy `/wfs` fixture remains available for API tests and benchmarks.

The prominent **Time & map area** panel above Dataset filters always remains available, including before loading or with Dataset filters collapsed. It defaults to **Last 24 hours**, shared by every enabled source. Choose Last hour, Last 6 hours, Last 7 days, **Custom range** (UTC), or **All time**. Presets apply immediately; custom ranges apply with **Apply time range** after validation. **Refresh time window** advances a relative window to now. The applied UTC range are displayed and remain fixed across sources and pages until changed/refreshed. A standalone local page visit defaults to the last 24 hours; named analyses restore their saved time choice and area as described above.

**Right-click and drag a box on the map** sets one shared geographic request bound for every enabled source, independently of the active Dataset filter group. A dashed outline and the bounds remain visible; another drag replaces the area, and **Clear map area** removes it while retaining the time window. Time and map-area changes cancel pending loads, clear old data, and reload enabled sources while retaining compatible chart settings and attribute selections. Individual raw-scatter observation selections are cleared on reload because their row indices belong to the previous load. Map-area reloads retain the viewport.

Time comparisons and geographic BBOX are encoded together in a standard XML **FILTER** parameter on GetFeature hits and every paged GetFeature request, so counts, paging and client limits describe the server-bounded dataset. WFS 2.0 uses FES 2.0, WFS 1.x uses OGC Filter Encoding. Area envelopes use explicit geographic CRS/axis order independent of the output GML CRS. The app does not fall back to an unbounded download when fields or filtering are unsupported. The test WFS implements this time/area subset before counting and paging.

The time and geometry attributes are detected from DescribeFeatureType when each has one unambiguous candidate. Under **WFS compatibility and limits**, set **Time attribute** / **Geometry attribute** overrides when schema discovery is unavailable or ambiguous. A source without a usable time attribute shows an actionable error for a time-bounded load; explicitly select All time to load timeless data. Server support for these standard predicates is required. Endpoint URLs containing pre-existing selection parameters must have those parameters removed before using the shared query controls.

The standalone **Timeline** directly above the map and charts, and above the record table on **Records**, selects an inclusive UTC window from **already loaded** enabled sources. Drag its window or the small ↔ grip to move through time, drag either edge to resize, or enter exact UTC endpoints and choose **Set window**. Clicking outside the window places it there. Arrow keys move or resize the focused control; Shift uses larger steps; Home/End move to the extent boundaries. **Show all loaded times** removes only the timeline selection. The same control stays at the bottom of enlarged map and chart dialogs, including narrow screens.

Timeline scrubbing never changes the applied WFS query or fetches additional features. It intersects the last **applied** per-source dataset/chart filters, updates every map layer and chart (including multiple-source charts), and also governs displayed records and CSV export. Unapplied filter edits stay unapplied. Its extent comes from loaded timestamps, so it reflects load limits and excludes disabled sources. Missing timestamps are excluded while active; sources with no usable timestamps remain displayed unchanged and are named below the slider. Choose a source time attribute when date fields are ambiguous. The selection is local to the current page session and resets when all loaded data is cleared. Timestamp columns and applied predicate masks are cached in workers; pointer input is coalesced per animation frame and only the latest pending window is retained while a worker is busy. Scrubbing preserves map camera and chart zoom.

Enabled sources load automatically on startup, when saved configuration changes, and when returning to analysis with unloaded data. **Load enabled sources** retries failed or cleared sources. Each source has its own worker, column store, GPU layer and colour. Analysis shows all enabled sources together. Choose **Filter data source** inside **Dataset filters** to edit that source’s rules; its name and matching point count identify the filter owner. **Point colouring** has its own independent **Colour data source** control, and **New chart data source** chooses the owner of a new chart. Switching one control does not change the others or hide any charts. In each chart’s **Settings**, choose **Data source** to populate its axes and aggregation fields from that dataset; the source name also appears on the collapsed card. Switching a chart’s source clears its old plot and incompatible axis choices, then recalculates against the new source. Chart clicks and raw/scatter selections filter the chart’s chosen source and update every chart using it. Manual rules, nested groups and selections remain separate per source and survive switching. Dataset filters never propagate to another server, even when feature IDs or attribute names overlap; only the shared time and map-area request bounds apply to all sources. Double-click metadata identifies the source as well as the feature.

Analysis data-source pickers list only enabled sources, including CSV export and each chart's Settings. Disabling a selected source moves the colour, filter, new-chart and export pickers to the first enabled source; with none enabled, these controls show an empty state. Existing chart cards keep their source assignment until explicitly reassigned or re-enabled.

At most two sources load concurrently; additional enabled sources wait in a queue. A source failure leaves other sources available. Saving a disabled source cancels its requests, terminates its worker, and releases its geometry/GPU buffers. Re-enabling reloads it and reapplies its analysis settings if the schema is unchanged. **Save changes** applies edited connection settings and reloads changed enabled sources. A changed schema refreshes that source’s chart fields, keeps compatible axis choices and resets its dataset filters. Disabled or cleared sources keep their chart cards visible with a load prompt; removing a source removes only charts assigned to it. Clearing datasets keeps their small analysis settings. Source configs persist across browser reloads; filters and chart layouts persist only for the current page session.

Charts are populated from DescribeFeatureType or the adapter's inferred schema. Initial charts choose categorical, date and numeric attributes when available. Add, remove, or reconfigure charts, with **Add chart** capped at 12 cards assigned to a source:

| Type | Attributes | Display and selection |
| --- | --- | --- |
| Bar | Any primitive attribute | Category counts or numeric/date histogram; click a bar |
| Pie | Any primitive attribute | Category counts or histogram; click a slice |
| Time series | Date X; optional numeric Y | Count, sum, mean, minimum or maximum by time interval; click a segment |
| Scatter | Two primitive attributes | Counted 2D bins, or every individual observation with binning off; click or right-drag a rectangle |

Bar, pie and time-series charts always aggregate the full selection into bounded categories or bins. Only scatter plots have a **No bins — individual points** option in the **Binning** dropdown, which draws **every non-null observation** with WebGL. There is no sampling or distinct-value cap for raw scatter; it retains original row IDs for point clicks, and overlapping dots return one observation. Each chart has a **Settings** toggle, collapsed by default, containing its chart type, attributes, binning and aggregation controls with visible labels and inline help. **Enlarge** and **Remove chart** stay visible in the header. Collapsing settings preserves the chart configuration, zoom and filters, including when enlarging and restoring. **Group by** selects the attribute counted by bar and pie charts; category and boolean attributes hide binning because they use fixed groups. **Time attribute** selects the date axis for time series. Scatter plots label the **X attribute** and **Y attribute** explicitly. **Binning** chooses 8–64 value ranges, time intervals, or bins per scatter axis; scatter also offers **No bins — individual points** in this same dropdown. Time-series **Y aggregation** selects count, sum, mean, min or max; the latter four enable a numeric **Y attribute** selector. Null Y values are excluded and counted as missing. Full-data domains and bin boundaries remain stable through filtering. Numeric ranges include the lower bound, exclude the upper bound, and include the maximum in the last bin. Millisecond time boundaries use exact integer edges.

Every chart uses the same mouse gestures: **left-drag a rectangle to zoom**, **right-drag to select**, and **double left-click to reset zoom**. Zoom only changes the local viewport; it does not filter the dataset, issue WFS requests or upload point data again. Single segment/point clicks and keyboard selection still filter. Scatter axes have numeric/date value ticks or shared text labels, axis titles, gridlines and readable UTC dates/times that adapt to the zoom level. Canvas and WebGL geometry use the same actual plot dimensions, including enlargement. Binned scatter selection chooses cells intersected by the range; raw scatter selection uses exact numeric/date bounds. Pie rectangle selection intersects its sectors.

Use **Enlarge** on the map or any chart for a large modal view. The map keeps its current centre, zoom, enabled layers, colours and selections, and its overlay shows only the total number of loaded points. **Return to normal size** or Escape restores the original position and size while retaining the zoom and source selection. Raw scatter supports arrow keys to step through original observations; Enter selects one.

Use **+ Add source** in a chart’s settings to compare enabled, loaded sources in the same existing bar, pie, time or scatter card. Each added source maps its own X field and, for scatter or measured time series, its own Y field. Bar/pie and count time series use point count as Y. Every shared axis requires the same type across sources: number, text, date or boolean. Incompatible mappings show a chart error without changing dataset filters. Numeric/date bins span the combined full datasets; text categories share labels. Scatter also supports text axes, including individual points.

A compact legend identifies source colours. Bars are grouped, time series and scatter share axes, and pies combine counts for each label across all sources before calculating percentage shares; source-coloured subdivisions show contributions within each label. Each series respects its source’s applied dataset filters. Bin/rectangle selections apply the corresponding original fields in every chart source; selecting an individual scatter observation acts only on its original source. Saved analyses retain field/source mappings, without saving chart results or raw records. Disabling/removing a member clears the comparison and requests that all members be loaded or the unavailable member removed.

Category charts retain the 23 most frequent categories from the full dataset and an exact **Other categories** segment when needed. Clicking Other matches every remaining non-null category. Missing attributes are excluded from plotted counts and reported separately. Plotted counts plus missing counts equal the current selection. Counts and keyboard selection are available in each chart's disclosure; focus a plot, use arrow keys, and press Enter to select a bin. Hovering a binned chart reads only its bounded aggregate counts and never queries individual map features.

In **Point colouring**, choose **Colour data source**, then **Point colour attribute**. **Single source colour** gives every point one configurable solid colour. Text fields appear under **Discrete colours · text fields**: every unique value receives a distinct default colour from the sorted full-data domain (independent of row order or filters), with a labelled picker to override it. Search values or use **Show more values** to edit large sets; values are never grouped into Other. Numeric fields appear under **Gradient · numeric fields** and use 8, 24 or 64 fixed full-data bins across configurable low/high colours. Only the controls for the selected mode are shown. Dates and booleans are not gradient fields; older saved colour attributes of these types fall back to a solid colour. Missing values are grey. Each source saves its attribute, solid colour, ramp and custom text colours separately; custom colours are retained when switching fields or modes. Filtering does not change colours. Gradients use one GPU byte per point; discrete colours use three RGB bytes per point without changing geometry or feature IDs. Numeric palette edits change uniforms; text colour edits regenerate only the compact colour buffer in the worker.

### CSV export

In **CSV export**, choose **Export data source** and click **Download CSV**. The file contains only that enabled source’s currently applied map selection, including manual AND/OR rules, chart selections, and the shared time/map-area query bounds. Panning and zooming do not add a filter; use the map-area selection to restrict the geographic extent. Export waits for loading and pending filter updates to finish. If the load limit was reached, only loaded points can be exported, and the export status says so.

Each file includes feature IDs, longitude/latitude and every attribute, with unique headers (generated ID/coordinate names gain a numeric suffix when an attribute already uses that name). Null values are empty, booleans are `true`/`false`, and dates are ISO 8601 UTC. Commas, quotes and embedded newlines are escaped with standard CSV quoting. A zero-match selection exports headers only. CSV generation runs in the source worker in batches; changing its selection or clearing/reloading the source cancels an in-progress download.

### Combined filters

Each filter group can use **AND** or **OR**, and groups can contain other groups. Use **Add chart selections here** to choose the receiving group; the highlighted group is the active target. Chart selections apply immediately. **Right-click and drag a box on the map** changes the shared server-side area bound described above. It does not add a local AND/OR selection. **Clear filters** removes the filter editor’s selected source’s attribute/chart predicates within the currently fetched time and area; **Clear map area** changes the area request bound. Manual rules and changed group operators apply with **Apply filters**. Removing a condition or clearing filters also updates the selection.

For example, create an AND root containing an OR group for `category = sensor` or `category = vehicle`, plus `value ≥ 50` and `timestamp ≥ 2025-01-01T00:00:00Z`. Range selections and scatter rectangles are nested AND expressions, so their endpoints remain together even inside an OR group. Repeated matching branches never duplicate features or counts.

A source’s charts and map layer use the **same complete-dataset selection**. The shared map displays the independently filtered layers of all enabled sources. Panning does not recompute chart counts. Empty AND groups match all rows; empty OR groups match none. Expressions support up to 128 nodes and 8 levels of nesting, with visible errors for excess complexity.

Numeric/date rules support equality, inequality and ranges. Dates accept ISO 8601; use `Z` or an explicit offset. Displayed dates are UTC. Text comparisons are case sensitive, including substring and lexical comparisons. Booleans accept `true`/`false` or `1`/`0`. Nulls match `is null` / `not null` and do not match ordinary comparisons, including inequality. There is no arbitrary JavaScript, SQL or CQL expression execution. Dataset filters become available after a completed load and run locally without WFS requests. The separate shared time and map-area controls reload server-bounded data.

Double-click a map point for metadata. Picking checks enabled layers from top to bottom with 9×9-pixel GPU ID passes until it finds a hit, then requests metadata from that source’s worker. Overlapping points return one hit. There is no map hover handler or overlap list. Cancel/clear terminates all source workers and frees their dataset buffers.

## Data source compatibility

1. On **Data sources**, use **Add data source** or **Configure** and enter the WFS URL. Vendor parameters and URL tokens are preserved.
2. Choose a WFS version, **Discover layers**, and choose a dataset from the **Feature layer** dropdown. Titles and exact layer names are shown together. Select **Custom layer name…** to type a name yourself; existing custom names are preserved when discovering.
3. Set the exact advertised output format. Prefer `application/json`; simple GML Point or single-point MultiPoint output also works.
4. Request `urn:ogc:def:crs:OGC:1.3:CRS84` for longitude/latitude. EPSG:4326 GML may require reversing the configured axis order. GeoJSON always uses longitude/latitude.
5. Choose a stable unique sort attribute if necessary. Keep the dataset unchanged throughout loading.
6. Use **Add to list** / **Update source**, then **Save changes**. Enabled new/changed sources load; use **Load enabled sources** after a browser reload. Analyze attributes and inspect points.

The adapter uses GetCapabilities, DescribeFeatureType, GetFeature hits (WFS 1.1/2.0) and bounded paged GetFeature requests. WFS 1.0 skips hits because that version has no standard resultType count; unknown totals load until an empty page or the client limit. GML 1.x numberOfFeatures describes the returned page rather than a matched total, and GML2 fid IDs are retained. One-page lookahead overlaps transfer with packing. Unknown totals load until an empty page or the explicit client limit. Server page caps are supported. The fixture serves up to 50 million deterministic points with eight fields: `id`, `category`, `status`, `value`, `timestamp`, `active`, `source`, `quality`. It supports UK, world and dense distributions, generates only requested pages, and does not allocate the full dataset on the server.

Supported scope: **WFS 2.0 paging**, GeoJSON FeatureCollections or simple GML 2/3 Point members using `pos`/`coordinates`, including single-point MultiPoint wrappers, primitive attributes, geographic coordinates within Web Mercator's ±85.05112878° latitude limit. WFS 1.x requires the server's `startIndex` paging extension. MultiPoint features containing zero or multiple locations, polygons, curves, geometry references, archives, and arbitrary projected CRS decoding are unsupported.

CORS must permit the browser origin, or serve behind a same-origin reverse proxy. Authentication supports same-origin cookies or endpoint URL tokens; custom authorization headers, OAuth UI and cross-origin cookie flows are not implemented. There is no unrestricted backend URL-fetching proxy.

Repeated IDs/pages, changed counts, premature empty pages, ignored page sizes, invalid geometry/coordinates and unexpected schema changes fail visibly. They cannot prove snapshot consistency when counts are stable but rows change or IDs are absent. Stable pagination and snapshot isolation remain server responsibilities. Client-limit truncation is explicitly reported; charts then describe only the loaded subset.

## Live public-service verification

Checked on **2 October 2026** against actual public endpoints in Chromium, with browser CORS enabled. The service responses were not mocked. Loads deliberately stop at **250 observations over three pages**; these checks establish compatibility, not full-catalogue performance.

| Service | Feature type | Successful configurations |
| --- | --- | --- |
| [Hamburg street trees](https://geodienste.hamburg.de/HH_WFS_Strassenbaumkataster) | `de.hh.up:strassenbaumkataster` | WFS 2.0: advertised `application/geo+json`, GML 3.2; singleton MultiPoint |
| [Berlin street trees](https://gdi.berlin.de/services/wfs/baumbestand) | `baumbestand:strassenbaeume` | WFS 2.0: GeoJSON and GML 3.2; WFS 1.1: GeoJSON and GML 3.1; WFS 1.0: GML2 |

[BfS radiation monitoring](https://www.imis.bfs.de/ogc/opendata/ows), layer `opendata:odlinfo_odl_1h_latest`, additionally exercises **dated** observations in WFS 2.0 GeoJSON. Set the time override to `end_measure` (the schema has two date attributes) and sort by `kenn`. The browser loads 250 recent observations in three pages, and its time-only and combined time/map filters match independently written CQL queries. A future custom range correctly returns zero rows while retaining the date schema. The test fixes the browser's preset reference time to one hour after an actual sampled observation, recording the exact window in its report. This service generates different WFS feature IDs on each request, so comparisons use stable station codes rather than assuming persistent server IDs.

Both tree sources require **All time**. Use stable sort fields `baumid` (Hamburg) and `gisid` (Berlin). Discovery now selects an advertised GeoJSON format if the current format is unsupported, reading per-layer, global or GetFeature format declarations. An already supported manual format stays unchanged. Discovery and schema reads allow 45 seconds for public servers while retaining cancellation.

For all seven configurations, paged IDs match a separate single-page query; charts account for every loaded row; local attribute filters make no new feature requests; truncation is explicit. Real right-drag map gestures return the same IDs as an independently expressed KVP BBOX, and clearing the area restores the original load. Hamburg returns six observations in the test area; Berlin returns five. Berlin's native projected-CRS envelope includes two points just outside the geographic box (roughly metre-scale); the independent BBOX query returns the same set. No claim of exact clipping beyond the server's BBOX semantics is made.

[GeoNet's current endpoint](https://wfs.geonet.org.nz/geonet/ows) was also probed: a two-earthquake basic GeoJSON request succeeds, but GetCapabilities and requests with `startIndex` or standard XML `filter` fail with HTTP 400. It is **not compatible** with the app's bounded paged loading interface; no unbounded fallback is used.

Run the opt-in live checks separately from CI:

```sh
npm run test:public-wfs
```

Reports: `benchmarks/public-wfs.json` and `benchmarks/public-wfs-time.json`. The runner hosts the built UI on an ephemeral local port, exercises normal source configuration and uses small public-server requests. Optional `PUBLIC_WFS_PROXY` and `PUBLIC_WFS_IGNORE_HTTPS_ERRORS=1` are test-runner controls for an intercepting development proxy; they never change application transport or CORS. The recorded run used that proxy with its test certificate exception and SwiftShader rendering.

Normal CI uses [captured public responses](tests/fixtures/public-wfs/README.md) for deterministic format discovery, GeoJSON/GML equivalence, singleton MultiPoint safety, legacy IDs and pagination regressions. It does not depend on public-server uptime.

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
node scripts/preview-sources.mjs
node scripts/benchmark.mjs 3000000
```

Current validation: **41 Node tests, 3 Rust unit tests and 68 browser tests pass**, with an offline vendored install and TypeScript/Vite build. Tests cover custom local basemap templates and persistence, time Y aggregation, scatter-only unbinned mode, exact-point picking and rectangle selection, geographic edge/antimeridian predicates, source-specific colour/box state, colour code memory and stable bins, and bounded non-scatter aggregation. Chart navigation tests cover canvas/WebGL zoom and reset without dataset changes, right-drag selection (including pie/time), date axes and millisecond precision across multi-year domains, modal enlargement/restoration, Escape, type switching, and removing an enlarged chart. Chart settings checks cover visible accessible labels, responsive control widths, category-specific controls, time Y visibility, and switching between raw scatter and bin counts in one dropdown.

Data source tests cover draft isolation, atomic saves, reload persistence, generic empty defaults, cancellation/discard, undo removal and removal of the final loaded source, legacy migration, normal query parameter preservation, test-server startup/addition, storage failure, discovery failure/cancellation, the eight-source limit, keyboard focus, and mobile layouts.

Analysis tests independently check nested expression semantics, missing values, constants, Other categories, chart totals, exact clicked bin membership, fractional time boundaries, cancellation and invalid schemas. Browser tests exercise schema-driven chart types, pie clicks, scatter dragging, OR chart selections, nested manual rules, keyboard selection, latest-request wins, multi-source isolation, distinct schemas, persistence, disable/re-enable, source-aware picking, partial failure, subpage navigation, GML, high-zoom picking and truncation. CI installs npm dependencies from the committed offline bundle; browser binaries are fetched separately for tests.

The analysis benchmark writes worker and browser round-trip timings plus a screenshot. The original benchmark tests pan/zoom; in-app **Performance measurements** also exports runtime metrics for hardware testing.

| File | Role |
| --- | --- |
| `src/analysis.ts` | Nested column-mask filtering, cached profiles and exact chart aggregation |
| `src/workspace.ts` | Filter groups, chart configuration, canvas plots, click/brush/keyboard selection |
| `src/data-sources.ts` | Draft source list, modal connection editor, explicit Save and optional test-server controls |
| `src/source-settings.ts` | Generic WFS defaults, saved settings migration and validation |
| `src/main.ts` | Named-analysis landing selector and page routing |
| `src/analysis-page.ts` | MapLibre, configuration subpage, worker coordination, metadata and metrics |
| `src/analysis-state.ts`, `src/saved-analysis.ts` | Configuration-only serialization, local bindings and save/share controls |
| `backend/` | Rust Poem/OpenAPI service, Diesel models and embedded PostGIS migrations |
| `src/store.ts` | Typed metadata columns, dictionaries and duplicate detection |
| `src/points-layer.ts` | GPU buffers, culling, rendering and double-click picking |
| `src/chart-plot.ts` | Shared chart axes, local viewport, pointer gestures and bounded pie-sector intersection |
| `src/raw-scatter.ts` | Unbinned WebGL charts, original-row picking, numeric/date brushing, readable axes and context recovery |
| `src/worker.ts` | WFS ingestion, analysis revisions and transferable results |
| `src/data.ts` | WFS decoding, schema types and coordinate packing |
| `server/` | Deterministic WFS fixture and built-app hosting, using Node built-ins |
| `scripts/install-offline.mjs` | Restore and install the committed integrity cache |

Application source is MIT-licensed. Dependencies retain their own licenses and exact lockfile versions.

### Time handling

All time windows, date filters, charts, metadata, saved timestamps and CSV exports use a 24-hour clock in UTC. CSV time columns and WFS date attributes without a timezone are interpreted as UTC. ISO 8601 timestamps with `Z` or numeric offsets (such as `+02:00`) are converted to UTC before filtering or analysis. Date-only values mean midnight UTC; invalid dates are rejected. Custom ranges accept `YYYY-MM-DD HH:mm:ss` (or ISO 8601), independently of your workstation timezone.

### Appearance

Use **Dark mode** in the page header to switch themes. The first visit follows your system preference; an explicit choice is saved in this browser and applies to the analysis picker, data sources, charts, map grid, legends and dialogs. Basemap tiles and analyst-configured point/banner colours retain their configured colours.

### Map legend

The map legend lists point colours for every enabled source below the normal map. Enlarging the map moves the same legend into a scrollable overlay; returning or pressing Escape puts it below the map again. It shows solid source colours, each numeric bin with its actual GPU palette colour, every category (including overrides), and grey missing values. Category domains remain fixed when filtering. Only visible legend rows are rendered, keeping large domains usable.

### Linked record inspection

Analysis setups have three pages: **Analysis**, **Data sources**, and **Records**
(`#records`). Records includes the shared time/map-area query controls, dataset filter editor, and timeline above the table. Edits, active groups, collapsed groups, and timeline selection persist when switching pages; choosing a records source also selects its filter editor. Records browses one enabled source's applied results, using a
worker-side search/sort index and a bounded 40-row viewport. The source, record
ID, coordinates, column types and null values remain explicit. Sources without
feature IDs show a load-local row number rather than inventing a stable ID.
Column selection affects table CSV exports; searches affect the table and its
export, not the map's applied filter. Copy record copies typed JSON. Arrow keys,
Home/End and Enter navigate/inspect records.

Double-clicking the map opens a paginated chooser when visible records overlap,
including records from different sources. The persistent inspector and map
marker follow inspection across pages. Charts expose **Inspect without
filtering** beside their existing filter action; individual scatter observations
also highlight when inspected elsewhere. Inspection is transient and cleared on
reload/filter changes. Raw records and inspection indices are never saved to the
analysis service.
