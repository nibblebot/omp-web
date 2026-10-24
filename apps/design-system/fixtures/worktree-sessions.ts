import type { SessionListEntry } from "#lib/wire/protocol";
import { rosterSessions } from "./roster";

const MIN = 60_000;
const DIR = "/home/joshua/.omp/sessions/omp-web";
const CWD = "/home/joshua/Repos/omp-web-worktrees/design-fixtures";

/**
 * A worktree's session list as the fleet answers it: a finished session, a failed
 * turn, a session titled by its first prompt, an interrupted one, and an empty one
 * (the dialog tags it). Newest first; the first path is the
 * design-fixtures worktree's last session.
 */
export function worktreeSessions(now: number): SessionListEntry[] {
	const [latest, middle, unnamed] = rosterSessions(now);
	if (!latest || !middle || !unnamed) return [];
	return [
		{
			...latest,
			status: "complete",
			firstMessage: "Add fixture modules for every roster story and seed them from one place.",
		},
		{
			...middle,
			status: "error",
			firstMessage: "Why do annotations lose their anchor after a rebase onto main?",
		},
		{
			...unnamed,
			status: "complete",
			firstMessage: "Why does the sidebar flash when a worktree wakes up?",
		},
		{
			path: `${DIR}/2026-10-05T14-21-50.jsonl`,
			id: "sess_5e8a77c1",
			name: "Wake pulse timing",
			cwd: CWD,
			modifiedAt: now - 4 * 24 * 60 * MIN,
			messageCount: 27,
			status: "interrupted",
			firstMessage: "The waking pulse stops before the attach lands; trace where it ends.",
		},
		{
			path: `${DIR}/2026-10-04T09-03-12.jsonl`,
			id: "sess_00000000",
			cwd: CWD,
			modifiedAt: now - 5 * 24 * 60 * MIN,
			messageCount: 0,
		},
	];
}

const TOPICS = [
	"Migrate roster rows to content height",
	"Settle list_daemon_sessions waiters per limit",
	"Resume picker keyboard navigation",
	"Anchor migration for stale annotations",
	"Fix the sidebar scroll jump on wake",
	"Trim the session file loader",
	"Review the clone lifecycle states",
	"Port the empty screen to compact rows",
];

/** The most the fleet returns (200 entries), for the dialog's "Showing the latest 200" note. */
export function worktreeSessionsMax(now: number): SessionListEntry[] {
	return Array.from({ length: 200 }, (_, i) => ({
		path: `${DIR}/max-${String(i).padStart(3, "0")}.jsonl`,
		id: `sess_${i.toString(16).padStart(8, "0")}`,
		name: `${TOPICS[i % TOPICS.length]} (${200 - i})`,
		cwd: CWD,
		modifiedAt: now - i * 97 * MIN,
		messageCount: 3 + (i % 41),
		status: i % 9 === 4 ? "error" : "complete",
		firstMessage: `Start of session ${200 - i}: ${TOPICS[(i + 3) % TOPICS.length]}.`,
	}));
}
