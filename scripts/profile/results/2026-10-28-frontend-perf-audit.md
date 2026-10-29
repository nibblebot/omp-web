# Frontend performance remediation (kata 90nc), 2026-10-28/29

Before/after A/B of the web UI for the frontend performance audit (`90nc`, items FP01-FP28). Base: `e809a46c` (main). After: `perf/integration` at `79a3780e` for M1, M3, M4, M5 and M7 (3 interleaved reps after the final transcript change), and at `78e91d1e` for M6 and M8-M11 (full 3-rep run; the later merges change only transcript scrolling and mounting, which those metrics do not exercise).

## Method

- Suite: a local A/B runner that boots each tree's own isolated fleet, a real session process, a deterministic fake model (streams markdown) and that tree's built `dist/`, then drives the real UI in headless Chromium over CDP (DOM, CDP and the wire only; no imports from `apps/web`). Kept outside the repo with the audit evidence (`~/.local/share/omp-web/perf-audit/2026-10-28/bench/`, README there).
- Host: i9-13900KF; runner and browser pinned to E-cores 24-31 (`taskset`), base and after interleaved metric by metric with alternating order per rep, 3 reps, medians reported. "4x" is CDP CPU throttling. A sleep inhibitor was held during the final runs; a run invalidated by a system suspend was discarded.
- Per-item before/after measurements by the fix owners (micro-benchmarks of real modules, Playwright/CDP scripts) are in each kata child's comments.

## Results (median of 3)

| Group | Metric | Unit | Base | After | Change |
|---|---|---|---:|---:|---:|
| M1 memory, live session | `items600.liveHeapMB` | MB | 73.5 | 42.5 | -42% |
| M1 memory, live session | `items1800.liveHeapMB` | MB | 397.4 | 113.8 | -71% |
| M1 memory, live session | `items1800.liveDomNodes` | nodes | 52620 | 52654 | +0% |
| M1 memory, live session | `push.msPerItem` | ms/item | 45.6 | 32.9 | -28% |
| M3 switch to a 300-turn session | `x1.plain.paintP50` | ms | 161.0 | 65.0 | -60% |
| M3 switch to a 300-turn session | `x1.md.paintP50` | ms | 596.0 | 182.0 | -69% |
| M3 switch to a 300-turn session | `x1.md.longTaskMax` | ms | 532.0 | 0.000 | -100% |
| M3 switch to a 300-turn session | `x4.md.paintP50` | ms | 2462 | 262.0 | -89% |
| M3 switch to a 300-turn session | `x4.md.longTaskMax` | ms | 2132 | 111.0 | -95% |
| M3 switch to a 300-turn session | `x4.empty.mainMsP50` | ms | 228.0 | 350.0 | +54% |
| M4 streaming 60 s | `r150c20.lastMsPerSec` | ms/s | 267.0 | 192.5 | -28% |
| M4 streaming 60 s | `r150c20.growth` | x last/first | 2.30 | 1.93 | -16% |
| M4 streaming 60 s | `r150c20.busyPct` | % | 19.4 | 14.8 | -24% |
| M4 streaming 60 s | `r150c20.layoutLastMsPerSec` | ms/s | 44.2 | 52.4 | +19% |
| M4 streaming 60 s | `r40c10x4.lastMsPerSec` | ms/s | 386.0 | 332.4 | -14% |
| M4 streaming 60 s | `r40c10x4.busyPct` | % | 32.4 | 29.9 | -8% |
| M5 interaction, 4x CPU | `stream.typing.p50` | ms | 57.7 | 44.6 | -23% |
| M5 interaction, 4x CPU | `stream.typing.p95` | ms | 78.6 | 58.9 | -25% |
| M5 interaction, 4x CPU | `stream.palette.p50` | ms | 132.9 | 122.4 | -8% |
| M5 interaction, 4x CPU | `stream.settings.p50` | ms | 307.0 | 119.6 | -61% |
| M5 interaction, 4x CPU | `stream.activities.p50` | ms | 149.7 | 111.0 | -26% |
| M5 interaction, 4x CPU | `idle.typing.p95` | ms | 24.4 | 34.5 | +41% |
| M5 interaction, 4x CPU | `idle.palette.p50` | ms | 34.4 | 40.5 | +18% |
| M5 interaction, 4x CPU | `idle.settings.p50` | ms | 185.4 | 42.2 | -77% |
| M7 idle | `none.mainMsPerSec` | ms/s | 3.35 | 0.230 | -93% |
| M7 idle | `empty.mainMsPerSec` | ms/s | 5.06 | 0.840 | -83% |
| M7 idle | `md300.mainMsPerSec` | ms/s | 23.1 | 4.44 | -81% |
| M7 idle | `md300.browserCpuMsPerSec` | ms/s | 41.5 | 17.0 | -59% |
| M6 socket drop, 300-turn session | `drop1.bytesKB` | kB | 3644 | 1.00 | -100% |
| M6 socket drop, 300-turn session | `drop1.historyFrames` | frames | 7.00 | 0.000 | -100% |
| M6 socket drop, 300-turn session | `drop1.longTaskMax` | ms | 520.0 | 0.000 | -100% |
| M6 socket drop, 300-turn session | `drop1.mainMs` | ms | 793.0 | 14.0 | -98% |
| M6 socket drop, 300-turn session | `drop1.attachedMs` | ms | 789.0 | 677.0 | -14% |
| M8 load (4x CPU, 150 ms RTT, 1.6 Mbps) | `entry.js.gzip` | kB | 245.1 | 216.4 | -12% |
| M8 load (4x CPU, 150 ms RTT, 1.6 Mbps) | `first.kB` | kB | 1196 | 270.7 | -77% |
| M8 load (4x CPU, 150 ms RTT, 1.6 Mbps) | `first.fcp` | ms | 5828 | 864.0 | -85% |
| M8 load (4x CPU, 150 ms RTT, 1.6 Mbps) | `first.rosterVisible` | ms | 5991 | 1840 | -69% |
| M8 load (4x CPU, 150 ms RTT, 1.6 Mbps) | `reload.kB` | kB | 1196 | 6.80 | -99% |
| M8 load (4x CPU, 150 ms RTT, 1.6 Mbps) | `reload.fcp` | ms | 5704 | 208.0 | -96% |
| M9 palette, 8 typed chars | `type.resumeList.calls` | calls | 8.00 | 1.00 | -88% |
| M9 palette, 8 typed chars | `type.answers.totalKB` | kB | 1437 | 0.300 | -100% |
| M9 palette, 8 typed chars | `type.serverCpuMs` | ms | 90.0 | 50.0 | -44% |
| M9 palette, 8 typed chars | `open.serverCpuMs` | ms | 10.0 | 20.0 | +100% |
| M10 subagent progress frame, 4x CPU | `cards20.msPerProgressFrame` | ms/frame | 252.0 | 30.9 | -88% |
| M10 subagent progress frame, 4x CPU | `cards40.msPerProgressFrame` | ms/frame | 925.7 | 27.8 | -97% |
| M11 settings | `attach.getSettings.kB` | kB/attach | 160.3 | 1.00 | -99% |
| M11 settings | `cycles.heapPerCycleMB` | MB | 2.99 | 0.070 | -98% |
| M11 settings | `cycles.domNodesDelta` | nodes | 194120 | 11980 | -94% |

## Notes

- Transcript mounting: a long transcript opens at its last 30 items and mounts the rest in idle-time chunks until every item is in the DOM (so the browser's find-in-page and free scrolling work). This was chosen over keeping only a window of items mounted. Measured on `289efe47`, the window variant held 24 MB at 1,800 items (vs 114 MB here, the same as a fresh reload of that transcript: steady-state full-mount memory) and was faster for input while streaming at 4x CPU: typing p50 22 ms (here 45), palette open 32 ms (122), Settings 38 ms (120), Activities 31 ms (111).
- Regressions against base, all in a 300-turn session at 4x CPU: switching from it to an empty session 228 -> 350 ms main thread (unmounting every item), typing p95 with nothing streaming 24 -> 35 ms and palette open 34 -> 41 ms (probably overlapping the ~6 s backfill at 4x; not confirmed), and palette open costs one 160 kB `getSettings` and 10 ms more session CPU (the settings model loads on first use instead of at every attach, which saves 159 kB per attach).
- Streaming (M4): late-reply cost is down about a quarter but still grows with reply length (1.9x from first to last 5 s, base 2.3x); see `pwzk`. Layout ms/s in the late window is +19% with overlapping ranges (44.2 [42.2..51.4] vs 52.4 [44.1..59.3]).
- Fleet CPU: `bun run profile --scenario combined,s4-subagents --reps 3` against a base baseline is within noise after the parked-channel pause (`stream_pause`/`stream_resume`).
- Not measured here: FP10 (reconnect on `online`/`pageshow`/`visibilitychange`) is not on this branch; it is covered by separate work (`snmj`). Hidden-tab behavior is proven by unit tests and request counts with a visibility stub, not by a hidden headless tab.
