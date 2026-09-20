---
title: Fleet and single-session modes
description: "The two ways to run omp-web: fleet mode, where a registry and supervisor manage many session daemons behind one sidebar, and single-session mode, where the browser talks to one session daemon directly."
---

omp-web runs in one of two runtime modes. Both serve the same browser UI and the same conversation experience, and both use the same wire contract between the browser and the process serving it. They differ in topology: how many session daemons exist, who starts and supervises them, and who serves the page.

You do not switch modes with a setting. The mode follows the process you point the browser at, and the page commits to it when the fleet announces its roster.

## Fleet mode

`omp-web` with no arguments starts the fleet, and it is the same as `omp-web serve`:

```sh
omp-web
```

The fleet is a registry, a supervisor, and the browser-facing server:

- It records the projects and worktrees you register.
- It starts local session daemons as child processes and dials remote ones.
- It supervises them: waking rows, restarting crashed processes, and tracking status.
- It serves the web UI, proxies browser traffic to the session daemon you select, and exposes a loopback control API that the `omp-web` CLI uses for the same fleet.

The UI and the control plane share one port, `4722` by default, and the startup banner prints the exact URL:

```text
fleet listening on 127.0.0.1:4722
Web UI: http://localhost:4722
```

The browser never talks to a session daemon directly in this mode. It attaches to a row, and every frame and command is proxied to that session daemon through the fleet. This is what makes it possible to keep a roster of many session daemons, switch between them in place, and watch the status of ones you are not viewing.

Fleet mode is the normal path once you work across more than one checkout. See [First run](/getting-started/first-run/) to start it and [Add your first project](/getting-started/add-first-project/) for the first registration.

## Single-session mode

`omp-web session` runs one session daemon and serves the browser UI itself:

```sh
omp-web session
```

The session daemon binds loopback port `4721` by default and logs the address to open:

```text
omp-session listening on http://localhost:4721
```

There is no roster and no registry in this mode. The browser's stream attaches to the one live session as soon as it opens, so the conversation appears without any selection step.

Single-session mode is useful when one directory and one conversation are all you need, including deployments that should not run a supervisor. The session daemon accepts the flags that describe its one process, among them `--cwd` for the bound directory (the current directory by default), `--port`, `--host`, `--token`, `--resume <file>`, `--idle-timeout`, `--name`, and `--label`. The [Reference](/reference/) carries the complete flag surface.

Fleet commands do not exist here. There is no registry to spawn into and no other session daemon to select, so the UI offers no project, worktree, or roster actions; a bare session daemon answers fleet-only commands as unknown.

## What differs between the modes

| Capability | Fleet mode | Single-session mode |
| --- | --- | --- |
| Command | `omp-web` (same as `omp-web serve`) | `omp-web session` |
| Browser connects to | the fleet, which proxies to the selected session daemon | the session daemon itself |
| Session daemons | many, started and supervised by the fleet | exactly one, started by you |
| Fleet sidebar and roster | yes | no |
| Project and worktree management | yes | no |
| Analysis transcripts and statistics | yes | no |
| Remote dial-in session daemons | yes | no |
| CLI control plane (`sessions`, `spawn`, `prompt`, and similar) | yes, against the running fleet | no |
| Session experience (prompting, queues, steering, tools, models, history actions, export) | yes | yes |
| Durable session transcripts | yes | yes |
| Browser-local preferences | yes | yes |

## How the page knows which mode it is in

The mode is decided by the wire, not by a build or a setting. When the fleet's edge starts streaming, it sends a `roster` frame with the current session daemons. That frame is the mode signal: the client enters roster mode and keeps it for the life of the page, including across reconnects, so late-proxied frames from an individual session daemon cannot flip the UI back. A bare session daemon never sends a `roster` frame, so its clients stay in single-session mode.

The Debug panel reports the resolved value as `mode` in its facts list, which is the quickest way to confirm which process a tab is actually talking to.

Because the mode is per connection, there is no in-page switch. To change modes, start or stop the other process and reload the page against its URL.

## Mode restrictions

Three restrictions are worth committing to memory because they shape what a page can do:

- **Analysis is available in fleet mode only.** The transcript and statistics views are served by the fleet's own routes, which exist only while a fleet process is running. Single-session mode has no Analysis entry point.
- **Collaboration rooms are operated through the CLI or TUI, not the browser.** omp-web currently has no browser collaboration surface in either mode.
- **Single-session mode has no fleet sidebar.** No roster, no project or worktree menus, and no Work and Analysis switch. The Work view is the only view.

Two more limits follow from the same boundary: fan-out prompting needs a fleet to fan out from, and remote session daemons can only be dialed in by a fleet.

## Running both at once

The two modes are separate processes and can run at the same time. A fleet-spawned session daemon is the same program with different flags: the default local spawn template runs `omp-web session --cwd {cwd} --port 0 --token {token} --name {name}` and then the fleet dials what that child reports. Nothing prevents you from running your own `omp-web session` on another directory while a fleet is running.

What does conflict is two fleets sharing one data home. Fleet state is protected by an exclusive lock for the lifetime of the owning process, so a second fleet against the same state file refuses to start and names the running holder instead of clobbering state. See [Session persistence](/concepts/session-persistence/) for what each process writes.

## Failure cases

- **The fleet URL does not answer.** Nothing is listening on that port: the fleet is not running, or it was started with a different `--port`. Start `omp-web` and use the printed `Web UI` URL.
- **The page has no sidebar and no project actions.** That is single-session mode. Project registration, worktrees, and the roster exist only in fleet mode; start `omp-web` and reload against its URL.
- **Prompts fail in either mode.** The mode is not the cause. A missing provider or default model stops prompts from resolving; see [Troubleshooting](/operations/troubleshooting/).
- **The page reports a lost connection.** In single-session mode the session daemon may have exited after its idle timeout. Start a session daemon again with `--resume` to reopen the same conversation; see [Session daemon lifecycle](/concepts/session-daemon-lifecycle/).

## Related

- [What is omp-web?](/getting-started/overview/) for the product-level comparison of the two modes.
- [Start your first session](/getting-started/start-first-session/) for the first-run path through fleet mode.
- [Session daemon lifecycle](/concepts/session-daemon-lifecycle/) for the states a session daemon moves through in either mode.
- [Local and remote sessions](/concepts/local-and-remote/) for dial-in session daemons, which only a fleet can host.
- [Interface tour](/getting-started/interface-tour/) for the panels the two modes share and the ones only fleet mode shows.
