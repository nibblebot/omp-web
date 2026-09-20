---
title: Troubleshooting
description: Fix common omp-web problems including missing omp setup, held locks, stuck session daemons, connection mismatches, worktree refusals, and stale statistics.
---

Most omp-web problems show up in one of three places: the status of a row in the [fleet sidebar](/fleet/sidebar/), the Debug panel, or the terminal output of the fleet or session daemon process. Find the symptom below and work through its checks. Setup failures are usually repaired in the `omp` CLI; locking, connection, and lifecycle failures are repaired by stopping or restarting the right process.

## `omp` is not installed

The first-run check resolves the `omp` CLI from `PATH`, then from `~/.bun/bin/omp`. When neither exists, the check prints `omp: NOT installed` together with the install command.

- Install the CLI with `bun install -g @oh-my-pi/pi-coding-agent`.
- Run `omp` once and configure a provider and a default model.
- Restart `omp-web` and confirm the check now reports `omp: installed (<path>)`.

The web UI serves without the CLI, but prompts fail until a model resolves.

## No authenticated provider

`providers: none configured` means the model registry found no provider with usable credentials. Credentials can come from the omp credential store, config keys, or environment variables; a provider whose credential lookup fails counts as unusable. A session daemon that cannot resolve a provider never becomes ready, so the composer stays blocked.

- Run `omp login` for an OAuth provider, or run `omp` and add a provider in `/settings`.
- Restart `omp-web`, or stop and wake the affected session daemon, so it resolves again.

## No default model

`default model: none` means the default-role model selector is empty. The session bar shows `no model`, and the model picker shows `No models available` when no model catalog is loaded.

- Run `omp`, open `/settings`, and set the default role to a model from an authenticated provider.
- Provider authentication and model selection are separate prerequisites. Fix both when both status lines are empty.
- Wake or restart the session daemon to re-resolve the model.

## Fleet state lock already held

Starting a second fleet against the same state file exits with status 77 and reports `fleet already running (pid <pid>)` along with the lock path, which is `<statePath>.lock`. A live omp-fleet process owns that lock.

- Keep using the fleet that is already running; its browser UI is the active instance.
- To start another one, stop the first cleanly with Ctrl+C in the terminal that runs `omp-web`.
- Never delete a lock held by a live process. A lock left behind by a crashed process is removed automatically on the next start.
- Two fleets must not share one state file. Give each one separate config and state paths.

## Session transcript lock already held

Every session file is locked for the lifetime of the session daemon that owns it, including a `--resume` target. A second session daemon on the same transcript exits 1 with `omp-session: session file <file> is locked by another omp-session (pid <pid>)`. This happens when, for example, a manually started `omp-web session --resume <file>` targets a transcript that a fleet-managed session daemon already owns.

- Keep one session daemon per transcript. Stop the other one with `omp-web stop <id>` (`omp-web sessions` lists the IDs), or resume a different session.
- Never delete a live lock. A lock left by a dead process is cleaned up on the next start.

## Fleet not running

A fleet control command with nothing listening on the loopback control port exits 1 and reports `fleet not running` along with the low-level start command, `omp-fleet serve`. In the browser, the Debug panel reports that the fleet control plane is unreachable when no fleet answers on port 4722.

- Start `omp-web` with no arguments. That runs the fleet, the supervisor, and the web UI; it is the same as `omp-web serve`.
- In single-session mode the browser talks directly to one session daemon, so the Debug panel's fleet notice is expected and harmless.
- If a fleet should be running, check the terminal that started it and confirm its control port (4722 unless configured otherwise).

## Session daemon stuck resolving

A sidebar row that stays on `resolving` (tooltip `resolving provider/model…`) means the session daemon connected and reported state, but never became ready. Readiness waits for provider, model, and authentication resolution, so check those first.

- Fix provider authentication and the default model in `omp`, then stop the row and wake it again so the session daemon resolves from scratch.
- Inspect the session daemon stderr for `omp-session: background model refresh failed: <error>` or `Failed to start agent session: <error>`. The Debug panel shows each session daemon's connector state and attempt count.
- If the status turns into an error reading `endpoint timeout: no OMP_SESSION| listening line within 30s`, the spawned process never printed its startup line on stdout. Fix the spawn template or wrapper so it emits the required `OMP_SESSION|` line; the supervisor ignores malformed output. An endpoint that resolves to an unusable URL fails with `invalid endpoint from child: <url>`.

## Protocol mismatch

The browser and the fleet connector fail closed when a session daemon speaks a different protocol version. The connector records `proto mismatch: daemon speaks OMP_PROTO <actual>, expected <expected>`, and the browser logs the short form before closing the stream.

- Run compatible releases on both sides. Update the browser side with `omp-web update`, update whatever starts the remote or session-side process, then restart or wake the session daemon.
- Reload the page. The browser does not schedule its normal reconnect loop after a protocol mismatch, because retrying cannot fix incompatible versions.

## Working-directory mismatch

An entry whose pinned working directory differs from the directory reported by the session daemon fails with `cwd mismatch: omp-session reports <reported>, registered <registered>`. This usually means a remote endpoint or a registry entry points at the wrong project or worktree.

- Confirm the session daemon was started in the intended directory, then correct or re-create the entry so it points there and reconnect.
- Entries added with an empty working directory adopt whatever the session daemon reports, so they cannot hit this check.
- Do not work around the check. It prevents attaching a sidebar row to the wrong repository.

## Unauthorized remote connection

A session daemon that is reachable off loopback requires its bearer token. A missing or wrong token returns HTTP 401 (`Unauthorized`); the fleet records `unauthorized (401): daemon rejected the token` and stops redialing. Starting a session daemon manually off loopback without a token is refused outright.

- Fleet-managed connections attach the token automatically. For a direct browser URL to a remote session daemon, include the exact `?token=<token>` value; tokens are case-sensitive.
- For a fleet-managed session daemon, stop it and wake it so the fleet mints a fresh token.
- For a manually launched remote session daemon, restart it with a known token, then correct or re-create any remote registration whose stored endpoint or token no longer matches.
- Start a standalone session daemon off loopback with `--token` or `OMP_SESSION_TOKEN`, and prefer SSH forwarding or a tailnet over exposing the port directly.

## Worktree branch already checked out

Git allows a local branch to be checked out in only one worktree. Creating a managed worktree from an existing branch fails with `branch is already checked out elsewhere: <branch>`. The branch picker lists checked-out branches last, disables them, and labels them `<branch> (checked out)`.

- Choose or create another branch, or free that branch by removing or switching the worktree that already uses it, then retry.

## Dirty worktree cannot be deleted

Worktree deletion is fail-closed. A worktree with added, modified, deleted, or untracked files is refused with `worktree has uncommitted changes: <path>`. Only paths under the configured workspace root are deletable from the UI; anything else is refused as `not a managed worktree (path outside workspaceDir)`.

- Commit, stash, move, or discard every change, including untracked files, with Git outside omp-web, then retry the deletion.
- There is no force-delete option, and optional branch deletion uses `git branch -d`, so a branch that is not fully merged is reported as not deleted.

## Statistics database is stale

Analysis reads token, cost, and error figures from `stats.db`. A session whose transcript exists on disk but is missing from the database shows `not synced` in its row and a `not indexed` tag; tool counts and durations still come from the live transcript, so the view is partial rather than broken.

- Click `Sync now` in the transcripts view or `Sync stats DB` in analytics. Syncing runs `omp stats --summary` on the server and refreshes the database view.
- If the banner reports `stats.db not found`, run `omp stats` once to build the index. An unreadable database is reported as `stats.db could not be opened at <path>`.
- Sync failures surface as `sync already in progress`, `sync timed out`, `omp stats failed`, or `omp binary not found`. For the last one, install it with `npm i -g @oh-my-pi/omp-stats` or add it to `PATH`.

## Browser keeps reconnecting

The Debug panel describes the stream. Connection `state` reads `disconnected` while a retry is pending, and `reconnect` shows the delay in milliseconds or `none (stream open)` when the stream is healthy.

- The client transport log names the case: `transient blip` (the browser's native EventSource replay handles it, no action needed), `silence deadline hit` (the stream was open but silent, so it reconnects immediately), or `connection lost` with the retry delay.
- After a terminal close the client retries at 1s, 2s, 4s, and up to 8s. When the stream opens again the backoff resets and roster mode reattaches the session daemon you were viewing. Readiness stays gated until the new stream reports ready.
- Wait for automatic recovery first. If it persists, check that the fleet and the session daemon are still running and that the network path between them is healthy.
- For a direct remote connection, verify the token; an unauthorized stream cannot recover by retrying. A protocol mismatch is also terminal and needs compatible versions instead of patience.

## Collect diagnostics for a bug report

Open the Debug panel with the info button in the status bar (or the one at the bottom of the fleet sidebar). It polls the fleet control plane every 2 seconds while open and keeps the last successful payload if a poll fails. Collect:

- Connection facts: `state`, `mode`, `session` ID, `client` ID, `last frame`, and `reconnect`.
- Fleet facts: `port`, `uptime`, `since`, the `state` path, and the `config` path.
- Session daemon rows: name or ID, status (hover for the error text), mode, PID, endpoint host, uptime, and the connector state with attempt count and next retry.
- The `Fleet log` and `Client transport` logs.

Also include the steps that reproduce the problem, what you expected, what happened instead, and the output of `omp-web --version` (or the commit when running from source), your OS, Bun version, installation method, and whether you use fleet mode or single-session mode. Remove secrets before posting: bearer tokens, authentication URLs and codes, and sensitive paths or transcript content. The fleet debug payload omits tokens, but pasted logs and screenshots can still contain them.

Missing fleet facts in single-session mode are expected, and fields the panel cannot read render as a dash.
