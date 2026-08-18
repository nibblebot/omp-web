#!/usr/bin/env bun
/**
 * omp-web — single installed entrypoint (Phase 2 packaging).
 *
 * Installed via `bun install -g` as the bundled `dist-bundle/cli.js`; bun
 * links it to `~/.bun/bin/omp-web` from the package `bin` field. Routes:
 *
 *   omp-web (bare) | omp-web serve|sessions|projects|spawn|add-repo|add|
 *           provision|stop|remove|rm-project|add-worktree|rm-worktree|prompt
 *                                     → fleet control-plane CLI (fleet/cli.ts;
 *                                       bare = serve)
 *   omp-web session [options]         → the omp-session daemon (server/index.ts;
 *                                       the dynamic import IS the daemon)
 *   omp-web update [options]          → self-update from the release channel
 *                                       (cli/update.ts)
 *   omp-web --version | version       → print version, exit 0
 *   omp-web <unknown>                 → usage on stderr, exit 1
 *
 * stdout contract: nothing is printed to stdout before delegating — fleet
 * `serve`'s banner line 1 and the daemon's `OMP_SESSION|` line stay parseable
 * by spawners.
 */

import { resolveVersion } from "./version";

/** Fleet control-plane verbs, kept in sync with fleet/cli.ts's USAGE. */
const FLEET_SUBCOMMANDS: Record<string, true> = {
	serve: true,
	sessions: true,
	projects: true,
	spawn: true,
	"add-repo": true,
	add: true,
	provision: true,
	stop: true,
	remove: true,
	"rm-project": true,
	"add-worktree": true,
	"rm-worktree": true,
	prompt: true,
};

/** Where argv routes the process. */
export type DispatchTarget = "fleet" | "session" | "update" | "version" | "usage";

/** Pure argv classification: argv here is process.argv.slice(2). A bare
 *  invocation routes to fleet serve — `omp-web` alone starts the fleet. */
export function classifyCommand(argv: string[]): DispatchTarget {
	const cmd = argv[0];
	if (cmd === "--version" || cmd === "version") return "version";
	if (cmd === "session") return "session";
	if (cmd === "update") return "update";
	if (cmd === undefined || cmd === "" || FLEET_SUBCOMMANDS[cmd]) return "fleet";
	return "usage";
}

const USAGE = `usage: omp-web [serve] [options] | omp-web <command> [options]

  (bare) | serve               start the fleet (registry + supervisor + edge);
                               first run with no config on a TTY offers setup
  sessions | projects          list registered daemons / projects
  spawn | add-repo | add | provision | stop | remove
  rm-project | add-worktree | rm-worktree | prompt
                               fleet control plane (see: omp-web <command> --help)
  session [options]            run a single-session agent daemon
  update [--check] [--force] [--version x.y.z]
                               self-update from the release channel
  --version | version          print version
`;

/** Version resolution lives in cli/version.ts (shared with omp-web update). */

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
			// `session` processes entirely. A bare `omp-web` is fleet serve.
			const { main } = await import("../fleet/cli");
			process.exit(await main(argv.length === 0 ? ["serve"] : argv));
			break;
		}
		case "session": {
			// Drop the `session` token so server/config.ts's parseConfig sees
			// exactly what `bun server/index.ts` would see, then hand the
			// process over. Static import is impossible here: server/index.ts
			// is top-level-executed (boots the daemon at module evaluation), so
			// loading it must stay deferred until the subcommand selects it.
			process.argv = [...process.argv.slice(0, 2), ...argv.slice(1)];
			await import("../server/index");
			break;
		}
		case "usage":
			console.error(USAGE);
			process.exit(1);
	}
}
