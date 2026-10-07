# Point ellipses

Configure **Ellipse fields (optional)** in a WFS or CSV source. Supply the semimajor axis, semiminor axis and orientation column names. Axis values are **radii**, with independent metres / nautical miles selectors (1 nautical mile = exactly 1,852 metres). Orientation is degrees clockwise from north. A missing, empty, nonnumeric or nonpositive axis, or missing/nonfinite orientation, skips that row's ellipse and reports a count; its point and attributes remain available. If the axes are reversed, rotate the axis direction by 90 degrees while swapping their lengths, preserving the shape.

The ellipse icon beside the map's enlarge control enables or disables all outlines. The adjacent settings popover changes **Vertices per ellipse** live, from 4 to 128 (default 12). It also chooses **Automatic** or **Every point** detail. Settings survive browser saves, remote saves and backups. Ellipses follow the same dataset colours, map-only legend visibility and local filters as their centre points. Point picking, records, charts and CSV exports continue to use the original points and attributes.

Automatic detail is the default to keep dense views responsive. It draws every outline when the viewport's spatial groups fit the detail budget, and samples outlines in excessively dense views (approximately one outline per 100 screen pixels, with a minimum budget of 2,000). Sampling is stable for a fixed camera and uses jitter to avoid favouring periodic input categories. Zoom in to restore all outlines, or choose Every point for uncapped fidelity. **No centre points or records are sampled or removed.** A full million overlapping, readable outlines can overwhelm a GPU; Every point explicitly permits that workload. Outlines smaller than 0.75 screen pixels are omitted in either mode while keeping their centres.

## Geometry and rendering

The ingestion worker packs four floats per point: angular semiaxes, orientation and latitude. Metres are converted using the mean Earth radius of 6,371,008.8 m. The vertex shader maps local east/north offsets along spherical geodesics to Web Mercator. For small ellipses it uses the tangent approximation only when the estimated second-order projection error is below 1/8 of a pixel. Centre positions retain the existing split-float precision. This is spherical ground-distance geometry, not an ellipsoidal surveying model. Centres and outline positions use the same Mercator polar clamp as point rendering.

Ellipse sample density in parameter angle is proportional to `sqrt(curvature) × speed`, or `1 / sqrt(speed)` up to a constant. Inverting its cumulative density concentrates samples at the major-axis tips and uses longer chords on flatter sides. A 64-entry logarithmic aspect-ratio lookup table (up to 1,024:1) amortizes this across every point. Six or twelve distinct vertices form a closed line strip; repeating its first vertex closes the strip.

GPU index textures preserve the existing spatial-group and filter order. Instanced drawing retrieves each centre and its axes, then expands only the chosen sample count in the shader. There are no per-row GeoJSON polygons, DOM elements or expanded CPU vertex arrays. Panning uses existing spatial group bounds, expanded conservatively for ellipse extent; dense automatic views choose index strides without rebuilding the point data. Colours and map visibility use a compact code/mask texture, and palette changes use uniforms.

For one million configured rows the additional ellipse attributes occupy 16 MB of CPU memory, and the additional GPU centres/axes/index textures approximately 36 MB. The vertex-count change adds only kilobytes of shared sample templates. Sources with no ellipse mappings allocate no ellipse GPU resources.

## Validation and reproduction

- `npm run build`
- `npm test`
- `npx playwright test tests/browser/ellipses.spec.ts`
- `cargo test --manifest-path backend/Cargo.toml --offline --locked --lib`
- `npm run benchmark:ellipses -- 1000000`
- `npm run benchmark:ellipses -- 1000000 --dense`

Browser checks cover actual rendered geodesic endpoints, colour codes and visibility masks, invalid-row retention, WFS and CSV ingestion, filters, source configuration, enlargement, automatic detail, full detail and settings persistence. Backup tests include migration of archives created before ellipse settings existed. Rust checks accept only the new metadata fields and reject invalid values.

Screenshots: [6 vertices](../benchmarks/ellipses-6-vertices.png), [12 vertices](../benchmarks/ellipses-12-vertices.png), [source settings](../benchmarks/ellipse-source-settings.png).

Benchmark results: [UK distribution](../benchmarks/ellipses-1000000.json), [dense distribution](../benchmarks/ellipses-1000000-dense.json). These measure actual browser render / RAF intervals, CPU draw submission and GPU allocation on Chromium with **SwiftShader software rendering**. They do not establish hardware-GPU frame rates. The dense fixture packs a million centres into roughly a 2 km square, with axis values from 0–100 m. The UK fixture exercises both subpixel overview outlines and readable zoomed-in outlines. Results report selected outline candidates; individual offscreen, subpixel or invalid ellipses can be rejected in the shader. Renderer errors and WebGL errors are checked.

## Observed benchmark timings

Million rows loaded in every scenario. These are short, sequential software-renderer runs; driver warmup and scheduling vary substantially, so apparent improvements are not evidence that enabling ellipses speeds up the map. CPU draw submission is not GPU completion time.

| Distribution / view | Outlines | Submitted candidates (p95) | Frame median / p95 (ms) | CPU draw p95 (ms) | GPU MB |
|---|---|---:|---:|---:|---:|
| UK / overview | Unconfigured | 0 | 184.8 / 210.4 | 0.1 | 20.00 |
| UK / detail | Unconfigured | 0 | 178.0 / 335.3 | 0.3 | 20.00 |
| UK / overview | Off | 0 | 194.4 / 205.1 | 0.2 | 56.14 |
| UK / overview | 6 vertices / auto | 0 | 185.6 / 361.4 | 0.2 | 56.14 |
| UK / overview | 12 vertices / auto | 0 | 177.7 / 190.5 | 0.2 | 56.14 |
| UK / detail | Off | 0 | 178.1 / 192.0 | 0.3 | 56.14 |
| UK / detail | 6 vertices / auto | 1,855 | 22.8 / 43.5 | 0.5 | 56.15 |
| UK / detail | 12 vertices / auto | 1,855 | 25.1 / 43.2 | 0.5 | 56.15 |
| Dense / detail | Unconfigured | 0 | 175.4 / 219.4 | 0.1 | 20.00 |
| Dense / detail | Off | 0 | 154.6 / 195.8 | 0.1 | 56.14 |
| Dense / detail | 6 vertices / auto | 4,808 | 183.6 / 364.7 | 0.2 | 56.15 |
| Dense / detail | 12 vertices / auto | 4,808 | 163.0 / 342.4 | 0.2 | 56.15 |
| Dense / detail | 6 vertices / every point | 1,000,000 | 254.4 / 669.1 | 0.2 | 56.15 |
| Dense / detail | 12 vertices / every point | 1,000,000 | 224.8 / 13272.8 | 0.1 | 56.15 |

The severe stalls in dense Every point mode are the reason for defaulting to Automatic detail. The implementation keeps rendering data intact and gives the user an explicit choice to pay for full outline fidelity. Unconfigured sources and subpixel overview outlines submit no ellipse geometry. Hardware smoothness still needs measurement on the deployment workstation.
