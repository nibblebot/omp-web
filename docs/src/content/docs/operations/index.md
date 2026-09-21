---
title: Operations
description: Run omp-web safely, diagnose failures, and recover processes.
---

Operations covers networking, authentication, updates, process recovery, diagnostics, and failure handling for the fleet and the session daemons it drives.

## Security boundaries

The fleet control plane binds to loopback by default, and loopback peers are exempt from credentials. Binding off loopback requires browser auth: one operator access token (stored only as its digest), a session cookie for non-loopback clients, and the CSRF header plus an allowed origin on mutations. A session daemon bound off-loopback requires a bearer token. Fleet-spawned session daemons receive fresh tokens, and browser roster frames do not expose tokens or endpoints. Remote transport security remains the operator's responsibility.

Downloaded files are restricted to approved filesystem roots, but configuration, state, transcript, and statistics files still require normal operating-system protections.

## Recovery

Session daemons are disposable. Idle processes can sleep, crashed processes receive bounded restart attempts, and the fleet can wake a stopped entry from its durable transcript. Lock errors protect fleet state and session transcripts from concurrent writers rather than indicating lost data.

## In this section

- [Networking and browser access](/operations/networking/) covers binding, remote browser access, and reachability failures.
- [Browser access and sign-in](/operations/browser-auth/) configures the operator access token and the proxy rules behind it.
- [Security model](/operations/security/) states what the application protects and what stays with the operator.
- [Updates](/operations/updates/) updates, pins, or replaces an installation and restarts processes safely.
- [Process lifecycle and recovery](/operations/lifecycle-and-recovery/) explains ownership, stop, sleep, wake, locks, and recovery order.
- [Debug panel and diagnostics](/operations/diagnostics/) collects diagnostic data without leaking secrets.
- [Troubleshooting](/operations/troubleshooting/) fixes common setup, connection, provider, worktree, statistics, and authorization failures.
