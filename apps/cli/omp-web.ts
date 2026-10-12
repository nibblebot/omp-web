#!/usr/bin/env bun
/**
 * omp-web: the single installed entrypoint (Phase 2 packaging).
 *
 * Installed from the release tarball into a pinned project dir
 * (`scripts/install-omp-web.ts`, default `~/.omp-web/install/`) with an
 * `omp-web` symlink in the bun bin dir; the bundle is `dist-bundle/cli.js`.
 * Routes:
 *
 *   omp-web [options] | omp-web control|ui|sessions|projects|profiles|spawn|
 *           add-repo|enroll|provision|add-clone|start|stop|remove|rm-project|
 *           add-worktree|rm-worktree|prompt|preflight
 *                                     → fleet control-plane CLI (apps/fleet/cli.ts;
 *                                       bare = control plane + UI)
 *   omp-web session [options]         → the omp-session daemon (apps/session/index.ts;
 *                                       the dynamic import IS the daemon; wire
 *                                       API only, no web UI)
 *   omp-web update [options]          → self-update from the release channel
 *                                       (apps/cli/update.ts)
 *   omp-web <unknown>                 → usage on stderr, exit 1
 *
 * stdout contract: nothing is printed to stdout before delegating. Bare
 * `omp-web`, `control`, and `ui` print their banner as the first stdout line
 * (`omp-web listening on ...`, `omp-web control listening on ...`,
 * `omp-web ui listening on ...`); the daemon's `OMP_SESSION|` line stays
 * parseable by spawners.
 */

import { resolveVersion } from "./version";

/** Fleet control-plane verbs, kept in sync with apps/fleet/cli.ts's USAGE. */
const FLEET_SUBCOMMANDS: Record<string, true> = {
	control: true,
	ui: true,
	sessions: true,
	projects: true,
	profiles: true,
	spawn: true,
	"add-repo": true,
	enroll: true,
	provision: true,
	"add-clone": true,
	start: true,
	stop: true,
	remove: true,
	"rm-project": true,
	"add-worktree": true,
	"rm-worktree": true,
	prompt: true,
	preflight: true,
};

/** Where argv routes the process. */
export type DispatchTarget = "fleet" | "session" | "update" | "version" | "help" | "usage";

/** Pure argv classification: argv here is process.argv.slice(2). A bare
 *  invocation, or one that starts with a flag (`omp-web --open`), routes to
 *  the fleet CLI, whose bare form runs control plane + UI. */
export function classifyCommand(argv: string[]): DispatchTarget {
	const cmd = argv[0];
	if (cmd === "--version" || cmd === "version") return "version";
	if (cmd === "--help" || cmd === "-h" || cmd === "help") return "help";
	if (cmd === "session") return "session";
	if (cmd === "update") return "update";
	if (cmd === undefined || cmd === "" || cmd.startsWith("-") || FLEET_SUBCOMMANDS[cmd])
		return "fleet";
	return "usage";
}

const USAGE = `usage: omp-web [options] | omp-web <command> [options]

  (bare)                       control plane + UI on one port (default 4722);
                               first run with no config on a TTY offers setup
  control                      control plane only, no UI (default port 4722)
  ui                           UI daemon: static UI + proxy to the control plane
                               (default port 4723)
  sessions | projects          list roster entries / unregistered worktrees
  profiles                     list provider profiles
  spawn | add-repo | enroll | provision | add-clone | start | stop | remove
  rm-project | add-worktree | rm-worktree | prompt | preflight
                               fleet control plane (missing arguments print
                               the command's usage)
  session [options]            run one agent session daemon (no web UI)
  update [--check] [--force] [--version x.y.z]
                               self-update from the release channel
  --version | version          print version

options (bare, control, ui):
  --port <n>                   listen port
  --control-port <n>           ui only: control plane to proxy to (default 4722)
  --open                       bare, ui: open the UI in a browser once ready
  --verbose                    bare, control: state/config paths and every
                               lifecycle event
`;

/** Version resolution lives in apps/cli/version.ts (shared with omp-web update). */

if (import.meta.main) {
	const argv = process.argv.slice(2);
	switch (classifyCommand(argv)) {
		case "version":
			console.log(await resolveVersion());
			process.exit(0);
			break;
		case "update": {
			// Kept out of the load path of --version/session like fleet: the
			// update graph only runs when selected.
			const { main } = await import("./update");
			process.exit(await main(argv.slice(1)));
			break;
		}
		case "fleet": {
			// Dynamic import by design: keeps the fleet graph (and its transitive
			// @oh-my-pi deps) out of the load path of `--version`, and out of
			// `session` processes entirely. A bare `omp-web` (or one starting
			// with a flag) has no verb, which the fleet CLI runs as control
			// plane + UI.
			const { main } = await import("../fleet/cli");
			process.exit(await main(argv));
			break;
		}
		case "session": {
			// Drop the `session` token so the session config's parseConfig sees
			// exactly what `bun apps/session/index.ts` would see, then hand the
			// process over. Static import is impossible here: apps/session/index.ts
			// is top-level-executed (boots the daemon at module evaluation), so
			// loading it must stay deferred until the subcommand selects it.
			process.argv = [...process.argv.slice(0, 2), ...argv.slice(1)];
			await import("../session/index");
			break;
		}
		case "help":
			console.log(USAGE);
			process.exit(0);
			break;
		case "usage":
			console.error(USAGE);
			process.exit(1);
	}
}
