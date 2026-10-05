# Two-million-row CSV ingestion profile

The fixture has 2,000,000 rows and 16 columns: longitude, latitude, UTC timestamp, two unique text columns and eleven numeric metadata columns. Each data record is exactly 100 bytes; the file is 200,000,091 bytes including its header. Each text column has 2,000,000 distinct values.

Measured with Chromium 141.0.7390.37, Playwright 1.56.1, Node 24.19.0, an 8 GiB container memory limit and the SwiftShader software renderer. These are measurements on this machine, not hardware-independent limits.

| Measurement | Before | Streamed import |
|---|---:|---:|
| Column picker ready | Crashed first | 48 ms after choosing file |
| Full import | Failed | 25.2 s |
| Import plus chart setup | Failed | 25.5 s |
| Peak browser process RSS total | 2.89 GB before crash | 1.45 GB |
| Main-thread JS heap after load | Unavailable after crash | About 7 MB |
| Data-worker JS heap after load | Never started | 408 MB |
| Data-worker array/backing storage | Never started | 295 MB |

Before: the renderer crashed about 20 seconds into upload. Chromium reported:

```text
Mark-Compact (reduce) 2040.8 (2048.4) -> 2036.5 (2040.6) MB
V8 javascript OOM (Ineffective mark-compacts near heap limit).
```

This was a JavaScript heap limit, before worker ingestion or map rendering of the dataset. There was no container OOM kill. The old editor called File.text(), built a full array of 32 million cells, and parsed the same contents again to populate column controls. Later ingestion also retained the complete row matrix and a complete array of GeoJSON feature objects before packing them.

The fix reads just the header in the editor and saves the original File/Blob directly to IndexedDB. The worker reads 1 MiB slices, infers whole-file types without retaining records, then builds and packs batches of at most 25,000 features. It retains only the column store and the dictionaries needed by analysis, rather than all intermediate representations. Memory still scales with loaded columns and distinct strings.

Worker CPU sampling after the fix attributed about 29.4% of samples to CSV scanning, 20.0% to Store.append and 4.0% to garbage collection. The worker profile includes ingestion and initial charts; sampling percentages are approximate.

The automated browser regression additionally verifies exact original IDs and unique values from the first, middle and last records, filters a unique text column to exactly one observation, checks the exported value, reloads the original 200 MB Blob, and verifies no crashes/page errors. Existing save failure, replacement, backup, sharing and million-row storage tests also pass.

Run the commands in README to regenerate the exact fixture and profiles. The raw fixture and CPU traces are intentionally generated artifacts; the checked-in summary records the measured run.
