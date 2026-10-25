# 2026-10-22: browser socket, WebSocket vs SSE+POST

Profiling summary for the client hop: browser to fleet (H1) and a direct client to a standalone session (H3). It moves from `GET /events` SSE + `POST /command` to one WebSocket on `GET /ws` (OMP_PROTO 5, `lib/wire/browser-socket.ts`). The callback pair (H2) is the WebSocket pair from `2026-10-22-callback-pair-websocket-vs-sse-post.md` in both arms, so this measures H1 alone. Kata: vyyq (spec), h14g (this run), decision 0da3, deferred measurements gmxn.

## Method

- **Harness:** `bun run profile --browser`, 5 reps x 20 s per scenario, 1 warmup. The isolated fleet runs real session processes against the fake model. The harness client speaks the wire under test: the `sse-post` adapter in the baseline and the `ws` adapter after. Command RTT is measured from send to the answer frame in both, and does not count the ack.
- **Host:** i9-13900KF, Bun 1.4.2, with the default pinning (fleet on cpu 0, sessions on 2/4/6/8, Chromium on 10/12, fake model on 16-23, harness on 24-31). Every run holds `flock /tmp/omp-web-profile.lock`.
- **Noise band:** 3 x MAD (floored), as `--compare` applies it. Anything flagged was rerun A-B-A, with the same-code drift sized by a rerun of the baseline code.
- **Attribution-only runs:** `--heap` was used only to find causes, never as a decision number.
- **Raw data:** the summaries are gitignored and kept locally under `.profile-out/` of the `ws-browser` worktree: baselines in `baselines/`, runs of the removed worktrees in `archive/<worktree>/`. They are only comparable on this host and pinning.

| Name | What | Commit | Run (under `.profile-out/`) |
|---|---|---|---|
| h1-sse-post | main with ws-h2 merged, H1 on SSE+POST | `473575ca` (where the `ws-browser` branch starts) | `archive/ws-h2-review/run-2026-10-22T20-21-26-957Z` |
| ws-browser-v1 | every vyyq slice merged, H1/H3 on `/ws` | `c3765e90` (branch `ws-browser`) | `run-2026-10-22T22-13-33-634Z` |

## Results (medians, ws-browser-v1 vs h1-sse-post)

| Scenario | Metric | SSE+POST | WebSocket | Verdict |
|---|---|---|---|---|
| s1-history | attach TTFF / primed ms | 4.45 / 11.0 | 4.13 / 8.01 | **improved** (-7% / -27%) |
| s1-history | reconnect resume / reattach-primed ms | 0.844 / 13.9 | 0.553 / 8.61 | **improved** (-34% / -38%) |
| s1-history | fleet + session CPU ms / 1k H1 frames | 596 | 597 | within noise |
| s1-history | fleet / session CPU ms, whole window | 1560 / 2920 | 1930 / 3750 | more work done, not a regression (below) |
| s1-history-large | attach drop rate | 0 | 0 | equal |
| s1-history-large | completed attach primed ms | 69.6 | 51.7 | **improved** (-26%) |
| s1-history-large | fleet CPU ms / 1k frames | 435 | 363 | **improved** (-16%) |
| s1-history-large | session peak RSS MiB | 536 | 677 | confirmed +25-29%, explained (below) |
| s2-text | stream latency p50 ms | 0.256 | 0.157 | **improved** (-39%) |
| s2-text | RTT under load p50 ms | 0.444 | 0.247 | **improved** (-44%) |
| s2-text | fleet CPU ms / 1k frames | 30.8 | 30.8 | equal |
| s3-tools | RTT under load p50 ms | 0.550 | 0.396 | **improved** (-28%) |
| s3-tools | stream p50 ms / forced resets | 0.453 / 0 | 0.447 / 0 | within noise / equal |
| s4-subagents | RTT under load p50 ms | 0.484 | 0.304 | **improved** (-37%) |
| s4-subagents | session CPU ms / 1k frames | 1090 | 1240 | flagged, same-code drift as large (below) |
| combined | stream latency p50 ms | 0.254 | 0.190 | **improved** (-25%) |
| combined | RTT under load p50 ms | 0.468 | 0.267 | **improved** (-43%) |
| combined | fleet + session CPU ms / 1k frames | 1280 | 1310 | within noise |
| browser-s2 (Chromium) | TTFF / primed ms | 18.1 / 37.9 | 18.1 / 44.3 | within noise |
| browser-s2 (Chromium) | stream latency p50 ms | 0.242 | 0.326 | flagged, same-code drift as large (below) |

Bold marks a change outside the noise band in the improving direction. There were 0 dropped attaches, 0 re-primes and 0 forced stream resets in every scenario in both arms. Fleet and session peak RSS are within noise everywhere except s1-history-large session RSS.

## Flagged deltas

Reruns were A-B-A on the flagged scenarios (`--browser --scenario s1-history-large,s4-subagents`, 5 reps each): ws-browser, then the baseline code, then ws-browser again.

| Metric | Head run 1 | Base rerun (A-A) | Head run 2 | Reading |
|---|---|---|---|---|
| s1-history-large session peak RSS MiB | 692 (+29%) | 534 (-0.3%) | 665 (+24%) | confirmed, cause below |
| s4 session CPU ms / 1k frames | 1170 (+7%) | 1190 (+9.5%) | 1210 (+12%) | drift: the baseline code moved as far |
| browser-s2 stream p50 ms | 0.320 (+32%) | 0.296 (+22%) | 0.266 (+10%) | drift: the baseline code moved +22% |
| s4 RTT under load p50 ms | 0.339 (-30%) | 0.619 (+28%) | 0.354 (-27%) | improvement holds |

- **s1-history total CPU (explained, not a regression):** each rep is a fixed window of back-to-back attaches. Attaches finish 27% faster, so 34% more attaches run (561 vs 417 attempts) and 27% more H1 frames go out. CPU per 1k frames is unchanged (597 vs 596 ms).
- **s1-history-large session peak RSS (confirmed, explained, accepted):**
  - The JS heap is not the cause. In a `--heap` run (3 reps, attribution only), live heap after a forced GC is identical: 86.7 vs 86.8 MiB used and 46.5 vs 46.5 MiB external on head vs base. So no memory is retained; the +25% is a transient peak footprint, not a leak. The `--heap` run's own peak RSS is not evidence either way, since its forced GCs and inspector change the very timing in question.
  - What changed is the rate. The edge's stream_ack credits now follow the socket's drain instead of the SSE queue, so the browser takes priming faster: H1 down bytes/s +34%, attach primed -26%. The session therefore turns history into frames 34% faster, and more garbage builds up between full collections. This is the GC-timing effect documented for the callback pair (vr40): the RSS is freed memory waiting on a collection and on mimalloc's purge delay, not retained data.
  - Not fixed here, tracked on gmxn next to the pair's RSS item. The candidate fixes measured there (purge delay 0, periodic `Bun.gc`) cost 20-31% session CPU.
- **s4 session CPU and browser-s2 stream p50 (unconfirmed):** the rerun of the unchanged baseline code moved by +9.5% and +22%, as far as the head runs did. At 5 reps these deltas are inside same-code drift. Not investigated further. The H3-only session changes (answer routing via AsyncLocalStorage, the loopback guard) run only on a standalone session's own listener, which the profiled fleet-managed sessions never bind. The delivery module still creates its AsyncLocalStorage at load; that cost was not measured separately.

## Decisions

- **H1 (browser to fleet): adopt WebSocket** (0da3). Per the bar in 0da3:
  - Fleet CPU per 1k frames is -16% on s1-history-large and equal elsewhere. So the change does not clear the CPU half of the bar, which was set for H2 and needs at least 10% on s1-history, s3 or combined.
  - Latency and RTT improve outside noise in every scenario that measures them (stream p50 -25% to -39%, RTT under load -28% to -44%). Attach priming is -26% to -27% and reconnect resume -34%.
  - Reliability stays equal: 0 resets, 0 re-primes, 0 drops.
  - The one confirmed regression, session peak RSS on the 23 MiB history, is GC timing driven by the faster priming, with no retained data.
  - The decision is the user's call from 2026-10-22 (vyyq), and these numbers support it: one wire for every client, with no regression in what a user sees.
- **H3 (standalone session listener): adopt WebSocket**, so the web client speaks one wire to the fleet and to a bare session. The profile harness drives only fleet-managed sessions, so H3 is covered by behaviour tests and a live direct-client check, not by numbers. Its direct path was never baselined.
- **Accepted trade:** session peak RSS +25-29% during priming of very large histories (gmxn).

## Open (gmxn)

- Session peak RSS during very large history priming, now on both hops: one GC after a large prime is still the untried candidate.
- s4 session CPU and browser-s2 stream p50 need more reps than 5 to resolve against same-code drift of 10-22%.
- The 4 MiB / 8 MiB history drop thresholds quoted in the s1 and s3 scenario texts were measured on SSE. No attach dropped on `/ws` at 23 MiB in any run; re-measure the threshold.
