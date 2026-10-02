These are actual local WFS/browser measurements, not a hardware-GPU performance claim. See the main README for the test environment, limitations and repeat instructions.

## Analysis workspace

`3000000-analysis-workspace.json` and `3000000-analysis-workspace.png` record the
schema-driven chart workspace. Run `npm run benchmark:analysis -- 3000000` after
building to reproduce it. Initial profile and chart computation took 302.2 ms;
a nested AND/OR filter with three chart recomputations took 170.7–230.8 ms in the
worker. All 500,040 matches were accounted for by each chart. These are worker
computation times. Browser round trips were 0.50–2.59 s on SwiftShader, including
GPU upload and automation polling. This run does not claim hardware rendering
smoothness or replace the earlier pan/zoom measurements.

## Simultaneous sources

`3000000-multi-source.json` and `3000000-multi-source.png` record two enabled
1.5-million-point WFS sources with separate workers, map layers, filters and
three charts per source. Run `npm run benchmark:sources -- 1500000` to reproduce.
Both datasets and initial charts were ready in 16.50 s; independent filter/chart
updates took 66.3 and 75.5 ms in their workers, with a 110.2-ms combined browser
round trip. Independently computed expected counts were 187,366 and 76,840,
matching every chart. This used SwiftShader and does not establish smooth
full-density map panning.
