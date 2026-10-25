# 2026-10-22: callback pair, WebSocket vs SSE+POST

Profiling summary for the transport between fleet and session (the callback pair, H2). It covers three SSE+POST milestones and the WebSocket pair that replaced them. The browser hop (H1, `GET /events` + `POST /command`) is SSE+POST in every run. Kata: epic fh4d, decision 0da3, tuning vr40, credit window 1vqd, deployment 8bvg, deferred measurements gmxn.

## Method

- **Harness:** `bun run profile --browser` with 5 reps x 20 s per scenario, 1 warmup, and an isolated fleet with real session processes and a fake model.
- **Host:** i9-13900KF, Bun 1.4.2, SDK 18.11.0. Pinning: fleet on cpu 0, sessions on 2/4/6/8, fake model on 16-23, harness on 24-31.
- **Noise band:** 3 x MAD (floored), the rule `--compare` applies. Two 5-rep runs of identical code differed by up to 12% CPU and 73% on p99 latency, so read single-run deltas near the band as unconfirmed.
- **Attribution-only runs:** `--heap` and `--cpuprofile` runs were used only to find causes, never as decision numbers.
- **Raw data:** the summaries are gitignored and kept locally under `.profile-out/baselines/` (`sse-post-v1`, `sse-post-v2`, `sse-post-v3`, `ws-v1`). They are only comparable on this host and pinning.

## Milestones

| Name | What changed | Measured at (branch `ws-h2`) |
|---|---|---|
| sse-post-v1 | Original NDJSON upload + SSE downlink pair | `42c4d380` |
| sse-post-v2 | Serialize each frame once; slimmer control mirror (1svw) | `2dc121d4` |
| sse-post-v3 | Priming paced by browser drain (0tas); make-before-break pair renewal (ddka); slim tool frames (ns60) | `630de1c4` |
| ws-v1 | Pair over one WebSocket, `OMP_CALLBACK_PROTO 2`; fleet relays session JSON; pair credit window (1vqd) | `593d815e` |

## Results (medians)

| Scenario | Metric | v1 | v2 | v3 | ws-v1 |
|---|---|---|---|---|---|
| s1-history | fleet CPU ms / 1k browser frames | 350 | 354 | 358 | **207** |
| s1-history | session CPU ms / 1k frames | 501 | 485 | 469 | **387** |
| s1-history | fleet peak RSS MiB | 263 | 275 | 280 | **205** |
| s1-history | session peak RSS MiB | 531 | 460 | 438 | 492 (+12%) |
| s1-history | attach TTFF / primed ms | 6.37 / 13.8 | 6.17 / 13.6 | 5.71 / 13.6 | **4.40 / 11.0** |
| s1-history-large | fleet CPU ms / 1k frames | 730 | 726 | 697 | **440** |
| s1-history-large | session peak RSS MiB | 587 | 586 | 482 | 514 (559 in a second run) |
| s1-history-large | attach drop rate / re-prime rate | 0.17 / 0.52 | 0.07 / 0.46 | 0 / 0 | 0 / 0 |
| s1-history-large | reconnect resume ms | n/a | n/a | 0.749 | 0.930 (open, see below) |
| s2-text | fleet CPU ms / 1k frames | 40.7 | 30.8 | 30.8 | 32.0 (+4%, out of band) |
| s2-text | pair bytes per browser frame | 733 | 419 | 387 | 387 |
| s2-text | stream p50 / RTT under load p50 ms | 0.241 / 0.498 | 0.255 / 0.498 | 0.232 / 0.511 | 0.244 / **0.443** |
| s3-tools | fleet CPU ms / 1k frames | 151 | 138 | 71.2 | **50.3** |
| s3-tools | pair bytes per browser frame | 32,500 | 27,700 | 8,700 | 8,680 |
| s3-tools | stream p50 ms | 2.13 | 1.92 | 1.38 | **0.42** |
| s3-tools | forced stream resets | 6 | 5 | 0 | 0 |
| s4-subagents | stream p50 ms | 2.80 | 1.29 | 2.21 | **0.43** |
| combined | fleet CPU ms / 1k frames | 154 | 120 | 81.1 | **61.5** |
| combined | fleet peak RSS MiB | 189 | 231 | 166 | **145** |
| combined | RTT under load p50 / p99 ms | 0.502 / 6.90 | 0.522 / 3.00 | 0.537 / 3.54 | **0.427 / 2.35** |
| browser-s2 (Chromium) | stream p50 / TTFF ms | 0.282 / 17.5 | 0.269 / 17.8 | 0.279 / 17.5 | 0.304 (+9%, out of band) / 17.9 |

Bold marks a change outside the noise band vs v3 in the improving direction. v1 to v3 was the SSE+POST work: it fixed the reliability problems (re-primes, attach drops, forced resets) without changing transport. ws-v1 against v3 measures the WebSocket pair plus the fleet relay and credit window. The WebSocket cutover by itself measured -30% s1-history, -21% s3 and -20% combined fleet CPU per 1k frames. That was the gv1m prototype run, before the relay, on the uncommitted tree later committed as `8a742f5c`; its fingerprint reads `f065a15a`, dirty. Serialize-once was already in v3. The relay (forwarding the session's JSON without re-stringifying) added the rest; it is not WebSocket-specific and would also work over SSE+POST.

## Decisions

- **H2 (fleet/session pair): adopt WebSocket** (0da3). Fleet CPU per 1k browser frames vs v3: -42% s1-history, -37% s1-history-large, -29% s3, -24% combined. Latency, RTT, attach and reliability are equal or better. Pair renewal, lineage and half-leg redial code is gone.
  - Proto 1 sessions are refused with 410 `proto_unsupported`, so running sessions must be restarted after the upgrade.
  - Text frames over Bun's built-in WebSocket, no per-message deflate, a 1 MiB send high-water mark.
- **Pair credit window** (1vqd): a session keeps at most 8 MiB in flight beyond what the fleet has consumed. The fleet grants credit (`pair_credit`, cumulative UTF-8 bytes) every 512 KiB, and a socket that runs past the window is closed with 4400. The `omp-web ui` forwarder bound is now window + one envelope instead of an empirical kernel-buffer guess. A/B against the commit before it showed no effect outside noise.
  - Accepted trade: a stuck async sink stalls the whole pair at the window until the session's 30 s stall redial. Previously the pair closed at 8 MiB. Today's edge sinks are synchronous, so production does not reach this path.
- **H1 (browser) and H3 (standalone session listener): stay on SSE+POST.** H1 is tracked separately in 2j84; the recommendation is no.
- **Session peak RSS accepted:** +12-16% on the s1 scenarios, measured but not fixed (below).

## Session RSS regression (accepted, open)

- **Size:** +12% s1-history; +16% and +7% in two s1-history-large runs. Fleet plus session peak is +3-7%, because the fleet drops 41-73 MiB.
- **Where it is not:** JS heap and external memory are equal to v3 after a forced GC. The send buffer, high-water mark, ack window and re-check timer are ruled out: `bufferedAmount` is 0 after every send.
- **Cause:** garbage-collection timing. JSC lets about 175 MiB build up between full collections, and freed memory then waits out mimalloc's purge delay. v3's queued byte buffers forced about 4x more full GCs.
- **Fixes measured, none shipped:**

| Knob | s1-large peak RSS | Session CPU |
|---|---|---|
| `MIMALLOC_PURGE_DELAY=0` | -18% | +31% |
| `Bun.gc(true)` every 250 ms | -27% | +31% |
| `Bun.shrink()` every 250 ms | -33% | about 2x |

- **Untried, deferred to gmxn:** one GC after a large history prime. Check first where the peak falls relative to priming.

## Tried and rejected

| Change | Result |
|---|---|
| Binary UTF-8 frames, byte-held payloads, cork | Session CPU +14% on history priming, fleet CPU +17% on s2 |
| Scratch-buffer (`encodeInto`) encoding | Session RSS +19.5%, fleet s2 CPU +27% |
| Session send re-check back-off 10 -> 50 ms | No effect; the high-water gate never engages in any scenario |
| Drop per-message identity fields (about 100 B) | -26% bytes per frame on s2, CPU within noise; checks kept as defense in depth (revocation already stops acceptance first) |
| npm `ws` instead of Bun's WebSocket | Not measured: it would run on Node compatibility layers and lose `drain` and `send()` return codes |

## Open (gmxn)

- **Reconnect timings:** s1-history-large reconnect resume 0.93 vs 0.749 ms and reconnect open +26%; combined reconnect resume +30%. These flagged in the ws-v1 run only; the earlier run on the same pair code was within noise. Not replicated or explained.
- **Untested at 5 reps:** combined s4 session CPU (+14% in one run) and s4 p99 RTT under load. Same-code drift was as large as the effect.
- **Chromium unmatched deltas:** browser-s2 `stream.unmatched` showed 4 of 8,000 deltas in one run, against 0 in ws-v1 and v3. The suspected cause, a wall-clock anchor error, is unverified.
- **Fleet JSON parsing:** the fleet's per-frame `JSON.parse` remains its largest JS cost on byte-heavy paths (13-17 s of about 75 s self time in a cpuprofile run). Header-only parsing is deferred; it needs an `OMP_PROTO` change.
