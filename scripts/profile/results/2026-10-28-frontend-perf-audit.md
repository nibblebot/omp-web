# Frontend performance remediation (kata 90nc), 2026-10-28/29

Before/after A/B of the web UI for the frontend performance audit (`90nc`, items FP01-FP28). Base: `e809a46c` (main). After: `perf/integration` at `289efe47` for M1, M3, M4 and M5 (3 interleaved reps after the last transcript-scrolling merge), and at `78e91d1e` for M6-M11 (full 3-rep run; the later merges touch only transcript scrolling and windowing, which those metrics do not exercise).

## Method

- Suite: a local A/B runner that boots each tree's own isolated fleet, a real session process, a deterministic fake model (streams markdown) and that tree's built `dist/`, then drives the real UI in headless Chromium over CDP (DOM, CDP and the wire only; no imports from `apps/web`). Kept outside the repo with the audit evidence (`~/.local/share/omp-web/perf-audit/2026-10-28/bench/`, README there).
- Host: i9-13900KF; runner and browser pinned to E-cores 24-31 (`taskset`), base and after interleaved metric by metric with alternating order per rep, 3 reps, medians reported. "4x" is CDP CPU throttling. A sleep inhibitor was held during the final run (an earlier run was invalidated by a system suspend; its data was discarded).
- Per-item before/after measurements by the fix owners (micro-benchmarks of real modules, Playwright/CDP scripts) are in each kata child's comments.

## Results (median of 3)

| Group | Metric | Unit | Base | After | Change |
|---|---|---|---:|---:|---:|
| M1 memory, live session | `items600.liveHeapMB` | MB | 73.5 | 14.2 | -81% |
| M1 memory, live session | `items1800.liveHeapMB` | MB | 397.4 | 24.3 | -94% |
| M1 memory, live session | `items1800.liveDomNodes` | nodes | 52620 | 4165 | -92% |
| M1 memory, live session | `push.msPerItem` | ms/item | 49.0 | 8.09 | -83% |
| M3 switch to a 300-turn session | `x1.plain.paintP50` | ms | 169.0 | 65.0 | -62% |
| M3 switch to a 300-turn session | `x1.md.paintP50` | ms | 598.0 | 198.0 | -67% |
| M3 switch to a 300-turn session | `x4.md.paintP50` | ms | 2471 | 203.0 | -92% |
| M3 switch to a 300-turn session | `x4.md.longTaskMax` | ms | 2181 | 0.000 | -100% |
| M3 switch to a 300-turn session | `x4.md.domNodes` | nodes | 143572 | 4433 | -97% |
| M4 streaming 60 s | `r150c20.lastMsPerSec` | ms/s | 287.0 | 185.7 | -35% |
| M4 streaming 60 s | `r150c20.growth` | x last/first | 2.32 | 1.83 | -21% |
| M4 streaming 60 s | `r150c20.busyPct` | % | 20.6 | 14.6 | -29% |
| M4 streaming 60 s | `r150c20.layoutLastMsPerSec` | ms/s | 49.5 | 51.4 | +4% |
| M4 streaming 60 s | `r40c10x4.lastMsPerSec` | ms/s | 441.2 | 281.6 | -36% |
| M4 streaming 60 s | `r40c10x4.busyPct` | % | 38.2 | 26.8 | -30% |
| M4 streaming 60 s | `r40c10x4.layoutLastMsPerSec` | ms/s | 51.3 | 56.6 | +10% |
| M5 interaction while streaming, 4x CPU | `stream.typing.p50` | ms | 60.3 | 22.1 | -63% |
| M5 interaction while streaming, 4x CPU | `stream.typing.p95` | ms | 76.3 | 28.4 | -63% |
| M5 interaction while streaming, 4x CPU | `stream.palette.p50` | ms | 131.9 | 32.0 | -76% |
| M5 interaction while streaming, 4x CPU | `stream.settings.p50` | ms | 288.3 | 38.4 | -87% |
| M5 interaction while streaming, 4x CPU | `stream.activities.p50` | ms | 157.9 | 31.3 | -80% |
| M5 interaction while streaming, 4x CPU | `idle.settings.p50` | ms | 179.5 | 27.7 | -85% |
| M6 socket drop, 300-turn session | `drop1.bytesKB` | kB | 3644 | 1.00 | -100% |
| M6 socket drop, 300-turn session | `drop1.historyFrames` | frames | 7.00 | 0.000 | -100% |
| M6 socket drop, 300-turn session | `drop1.longTaskMax` | ms | 520.0 | 0.000 | -100% |
| M6 socket drop, 300-turn session | `drop1.mainMs` | ms | 793.0 | 14.0 | -98% |
| M6 socket drop, 300-turn session | `drop1.attachedMs` | ms | 789.0 | 677.0 | -14% |
| M7 idle | `none.mainMsPerSec` | ms/s | 3.02 | 0.220 | -93% |
| M7 idle | `empty.mainMsPerSec` | ms/s | 4.57 | 0.790 | -83% |
| M7 idle | `md300.mainMsPerSec` | ms/s | 22.4 | 1.22 | -95% |
| M7 idle | `md300.browserCpuMsPerSec` | ms/s | 41.0 | 5.50 | -87% |
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

- Streaming (M4): late-reply main-thread cost is down about a third, but it still grows with reply length (1.8x from first to last 5 s, base 2.3x): the remaining cost is layout, cull-rect and scroll-anchor work over the growing live block (`pwzk`). Containing finished segments with `contain: paint` or `content-visibility` breaks margin collapsing between them, so they get `isolation: isolate` only. Layout ms/s in the late window is within noise of base (+4% at 150x20, +10% at 4x; ranges overlap). A +20% layout reading on `78e91d1e` went away once pinning became intent-only (`overflow-anchor: none` while pinned).
- Palette open costs one 160 kB `getSettings` (the settings model now loads on first use instead of at every attach) and 10 ms more session CPU on that open; every attach saves 159 kB.
- Fleet CPU: `bun run profile --scenario combined,s4-subagents --reps 3` against a base baseline is within noise after the parked-channel pause (`stream_pause`/`stream_resume`); before that fix the parked resume channels doubled session-to-fleet traffic (combined `cpu.fleet.ms` 490 to 610 ms).
- Not measured here: FP10 (reconnect on `online`/`pageshow`/`visibilitychange`) is not on this branch; it is covered by separate work (`snmj`). Hidden-tab behavior is proven by unit tests and request counts with a visibility stub, not by a hidden headless tab.
