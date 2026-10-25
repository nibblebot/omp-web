import type { ClientCommand, RosterEntry, ServerFrame } from "#lib/wire/protocol";
import { OMP_PROTO } from "#lib/wire/protocol";
import { publish } from "../fake-socket";
import { rosterAppEntries } from "./roster";

/**
 * The App screen's fleet: the priming a fresh browser socket gets and the
 * commands the fake edge answers itself (fake-socket.ts carries both over
 * `/ws`). App calls the real connect(), so the socket must look like the fleet
 * edge: a `roster` frame before `hello_ok`. Roster changes are live deltas
 * broadcast to every connection. Attach answers like the edge: an id-keyed
 * `attach_result` to the asker, then the proxied `attached`; the session's
 * transcript is restored in the page (app-view.tsx). `call()` answers for
 * stories come from the page instead (session.ts).
 */

/** The App's roster; asleep entries turn ready when woken. Reset on every fresh priming (a page load). */
let roster: RosterEntry[] = structuredClone(rosterAppEntries);

/** Priming for a fresh dial: the roster, then hello_ok. Resets the roster to its fixture state. */
export function primingFrames(): ServerFrame[] {
	roster = structuredClone(rosterAppEntries);
	return [
		{ type: "roster", entries: roster },
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

/** Wake an asleep session the way spawn_resume does, and broadcast the new roster. */
function wake(workspaceId: string): void {
	const entry = roster.find((d) => d.workspaceId === workspaceId);
	if (entry === undefined || entry.status !== "asleep") return;
	const now = Date.now();
	roster = roster.map((d) =>
		d === entry ? { ...d, status: "ready", desiredState: "running", readyAt: now, uptime: 0 } : d,
	);
	publish({ type: "roster", entries: roster });
}

/** The entry after its session process stops: asleep, with no live process fields. */
function asleep(entry: RosterEntry): RosterEntry {
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
		wake(cmd.workspaceId);
		return true;
	}
	if (cmd.type === "stop") {
		const { workspaceId } = cmd;
		if (!roster.some((d) => d.workspaceId === workspaceId)) {
			publish({ type: "error", error: `unknown session: ${workspaceId}` });
			return true;
		}
		// Local only: the roster changes, no process is touched. The broadcast
		// drives the web's own reconcile (a stopped attached session clears the
		// chat column), as the edge's registry change does.
		roster = roster.map((d) => (d.workspaceId === workspaceId ? asleep(d) : d));
		const row = roster.find((d) => d.workspaceId === workspaceId);
		publish({ type: "roster_delta", upserted: row ? [row] : [], removed: [] });
		return true;
	}
	if (cmd.type === "attach") {
		const { workspaceId } = cmd;
		if (!roster.some((d) => d.workspaceId === workspaceId)) {
			answer({
				type: "attach_result",
				id: cmd.id,
				ok: false,
				error: `unknown session: ${workspaceId}`,
			});
			return true;
		}
		// The edge wakes a stopped session before answering its attach.
		wake(workspaceId);
		answer({ type: "attach_result", id: cmd.id, ok: true, workspaceId });
		publish({ type: "attached", workspaceId });
		return true;
	}
	return false;
}
