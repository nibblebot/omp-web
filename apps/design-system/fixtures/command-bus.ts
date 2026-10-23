import type { ClientCommand, DaemonEntry, ServerFrame } from "#lib/wire/protocol";
import { OMP_PROTO } from "#lib/wire/protocol";
import { publish } from "../fake-socket";
import { rosterAppDaemons } from "./roster";

/**
 * The App screen's fleet: the priming a fresh browser socket gets and the
 * commands the fake edge answers itself (fake-socket.ts carries both over
 * `/ws`). App calls the real connect(), so the socket must look like the fleet
 * edge: a `roster` frame before `hello_ok`. Roster changes are live deltas
 * broadcast to every connection. Attach answers like the edge: an id-keyed
 * `attach_result` to the asker, then the proxied `attached`; the session's
 * transcript is restored in the page (app-view.tsx). `call()` answers for
 * stories come from the page instead (daemon.ts).
 */

/** The App's roster; asleep entries turn ready when woken. Reset on every fresh priming (a page load). */
let roster: DaemonEntry[] = structuredClone(rosterAppDaemons);

/** Priming for a fresh dial: the roster, then hello_ok. Resets the roster to its fixture state. */
export function primingFrames(): ServerFrame[] {
	roster = structuredClone(rosterAppDaemons);
	return [
		{ type: "roster", daemons: roster },
		{
			type: "hello_ok",
			proto: OMP_PROTO,
			name: "design-fixtures",
			cwd: "/home/joshua/Repos/omp-web",
			pid: 4242,
			version: "design-system",
		},
	];
}

/** Wake an asleep daemon the way spawn_resume does, and broadcast the new roster. */
function wake(daemonId: string): void {
	const entry = roster.find((d) => d.daemonId === daemonId);
	if (entry === undefined || entry.status !== "asleep") return;
	const now = Date.now();
	roster = roster.map((d) =>
		d === entry ? { ...d, status: "ready", desiredState: "running", readyAt: now, uptime: 0 } : d,
	);
	publish({ type: "roster", daemons: roster });
}

/** The entry after its daemon process stops: asleep, with no live process fields. */
function asleep(entry: DaemonEntry): DaemonEntry {
	const { readyAt: _readyAt, uptime: _uptime, pid: _pid, ...rest } = entry;
	return { ...rest, status: "asleep", desiredState: "stopped" };
}

/**
 * Answer the commands this bus owns. Returns false for any other command so
 * the caller can refuse it; `answer` sends an id-keyed frame to the asker.
 */
export function answerBusCommand(
	cmd: ClientCommand,
	answer: (frame: ServerFrame) => void,
): boolean {
	if (cmd.type === "spawn_resume") {
		wake(cmd.daemonId);
		return true;
	}
	if (cmd.type === "stop") {
		const { daemonId } = cmd;
		if (!roster.some((d) => d.daemonId === daemonId)) {
			publish({ type: "error", error: `unknown daemon: ${daemonId}` });
			return true;
		}
		// Local only: the roster changes, no process is touched. The broadcast
		// drives the web's own reconcile (a stopped attached daemon clears the
		// chat column), as the edge's registry change does.
		roster = roster.map((d) => (d.daemonId === daemonId ? asleep(d) : d));
		const row = roster.find((d) => d.daemonId === daemonId);
		publish({ type: "roster_delta", upserted: row ? [row] : [], removed: [] });
		return true;
	}
	if (cmd.type === "attach") {
		const { sessionId } = cmd;
		if (!roster.some((d) => d.daemonId === sessionId)) {
			answer({
				type: "attach_result",
				id: cmd.id,
				ok: false,
				error: `unknown daemon: ${sessionId}`,
			});
			return true;
		}
		// The edge wakes a stopped daemon before answering its attach.
		wake(sessionId);
		answer({ type: "attach_result", id: cmd.id, ok: true, sessionId });
		publish({ type: "attached", sessionId });
		return true;
	}
	return false;
}
