import type { SessionListEntry } from "#lib/wire/protocol";
import { call, state, setState } from "../state";
import { requestWorkspaceSessions, resumeSession, spawnProjectSession } from "./roster";
import {
	type SessionRow,
	type SessionStatus,
	normalizeSessionTitle,
	projectLabelFromCwd,
	resolveSessionOwner,
	sessionStatus,
	trimTrailingSlashes,
	validateSessionDelete,
} from "./session-list";

// ---------------------------------------------------------------------------
// Local DTOs (P0 moves the canonical shapes into protocol.ts).
// Every normalizer treats the payload as untrusted: wrong shapes yield
// explicit errors / empty mirrors, never throws out of the store.
// ---------------------------------------------------------------------------

/** One resumable session for the picker. Identity is `id` + `sessionFile`. */
export interface ResumeCandidate {
	id: string;
	sessionFile: string;
	cwd: string;
	title?: string;
	createdMs?: number;
	modifiedMs: number;
	messageCount: number;
	status?: SessionStatus;
	firstMessage?: string;
	recentText?: string;
	pinned: boolean;
	scope: "local" | "global";
}

export type ResumeResolveOutcome =
	| { kind: "unique"; session: ResumeCandidate }
	| { kind: "ambiguous"; candidates: ResumeCandidate[] }
	| { kind: "missing"; searched: number }
	| { kind: "refused"; message: string }
	| { kind: "unknown"; message: string };

function errText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

/** Pinned-id sets arrive as string arrays; anything else degrades to empty. */
function asIdList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((v): v is string => typeof v === "string" && v.length > 0);
}

function normalizeCandidate(
	value: unknown,
	pinnedIds: ReadonlySet<string>,
): ResumeCandidate | null {
	const r = asRecord(value);
	if (r === null) return null;
	// Accept both the adapter shape (id/sessionFile) and the existing
	// SessionListEntry shape (id/path) for explicit roster-owned picks.
	const id = asString(r.id);
	const sessionFile = asString(r.sessionFile) ?? asString(r.path);
	if (!id || !sessionFile) return null; // stable IDs only: no text/row identity
	const modifiedMs = asNumber(r.modifiedMs) ?? asNumber(r.modifiedAt) ?? 0;
	return {
		id,
		sessionFile,
		cwd: asString(r.cwd) ?? "",
		...((asString(r.title) ?? asString(r.name) !== undefined)
			? { title: (asString(r.title) ?? asString(r.name)) as string }
			: {}),
		...(asNumber(r.createdMs) !== undefined ? { createdMs: asNumber(r.createdMs) } : {}),
		modifiedMs,
		messageCount: asNumber(r.messageCount) ?? 0,
		...(sessionStatus(r.status) !== undefined ? { status: sessionStatus(r.status) } : {}),
		...(asString(r.firstMessage) !== undefined ? { firstMessage: asString(r.firstMessage) } : {}),
		...(asString(r.recentText) !== undefined ? { recentText: asString(r.recentText) } : {}),
		pinned: asBoolean(r.pinned) ?? pinnedIds.has(id),
		scope: r.scope === "global" ? "global" : "local",
	};
}

function normalizeCandidates(data: unknown, pinnedIds: ReadonlySet<string>): ResumeCandidate[] {
	const root = asRecord(data);
	const list = root !== null && "candidates" in root ? root.candidates : data;
	if (!Array.isArray(list)) return [];
	const out: ResumeCandidate[] = [];
	for (const item of list) {
		const c = normalizeCandidate(item, pinnedIds);
		if (c !== null) out.push(c);
	}
	return out;
}

// ---------------------------------------------------------------------------
// Mirrors in the application's one Solid store.
// ---------------------------------------------------------------------------

export interface ResumeState {
	candidates: ResumeCandidate[];
	pinnedIds: string[];
	query: string;
	total: number;
	allProjects: boolean;
	ambiguous: ResumeCandidate[] | null;
	loading: boolean;
	error: string | null;
	notice: string | null;
	capabilities: Record<string, boolean> | null;
	unavailable: string | null;
}

export function createResumeState(): ResumeState {
	return {
		candidates: [] as ResumeCandidate[],
		pinnedIds: [] as string[],
		query: "",
		total: 0,
		allProjects: readAllProjects(),
		ambiguous: null as ResumeCandidate[] | null,
		loading: false,
		error: null as string | null,
		notice: null as string | null,
		capabilities: null as Record<string, boolean> | null,
		unavailable: null as string | null,
	};
}

/** Persisted "All projects" scope: only a stored "true" widens the list. */
function readAllProjects(): boolean {
	if (typeof localStorage === "undefined") return false;
	return localStorage.getItem("omp.resumeAllProjects") === "true";
}

// Accessors retain the existing component API while all mirrors live in the
// application's one Solid store. Functional updates read that same snapshot.
function resumeField<K extends keyof ResumeState>(
	key: K,
): [
	() => ResumeState[K],
	(value: ResumeState[K] | ((previous: ResumeState[K]) => ResumeState[K])) => void,
] {
	return [
		() => state.resume[key],
		(value) => {
			const next =
				typeof value === "function"
					? (value as (previous: ResumeState[K]) => ResumeState[K])(state.resume[key])
					: value;
			setState("resume", key, next);
		},
	];
}

const [resumeCandidates, setResumeCandidates] = resumeField("candidates");
const [resumePinnedIds, setResumePinnedIds] = resumeField("pinnedIds");
const [resumeQuery, setResumeQuery] = resumeField("query");
const [resumeAmbiguous, setResumeAmbiguous] = resumeField("ambiguous");
const [resumeLoading, setResumeLoading] = resumeField("loading");
const [resumeError, setResumeError] = resumeField("error");
const [resumeNotice, setResumeNotice] = resumeField("notice");
const [resumeCapabilities, setResumeCapabilities] = resumeField("capabilities");
const [resumeUnavailable, setResumeUnavailable] = resumeField("unavailable");
export const [resumeAllProjects, setAllProjectsFlag] = resumeField("allProjects");
export const [resumeTotal, setResumeTotal] = resumeField("total");

export {
	resumeCandidates,
	resumePinnedIds,
	resumeQuery,
	resumeAmbiguous,
	resumeLoading,
	resumeError,
	resumeNotice,
	resumeCapabilities,
	resumeUnavailable,
};

// ---------------------------------------------------------------------------
// Resume actions
// ---------------------------------------------------------------------------

/** Capability probe: the server's resume-surface verdicts (resolve, manage). */
export function refreshResumeCapabilities(): void {
	void call("getResumeCapabilities")
		.then((data) => {
			const root = asRecord(data);
			if (root === null) {
				setResumeCapabilities(null);
				return;
			}
			const caps: Record<string, boolean> = {};
			for (const key of ["resolve", "manage"] as const) {
				const entry = asRecord(root[key]);
				const available = entry !== null ? asBoolean(entry.available) : asBoolean(root[key]);
				caps[key] = available ?? false;
			}
			setResumeCapabilities(caps);
			setResumeUnavailable(null);
		})
		.catch((err) => {
			setResumeCapabilities(null);
			setResumeUnavailable(`Targeted resume unavailable: ${errText(err)}`);
		});
}

/**
 * Open the resume picker (bare /resume). Loads capabilities + candidates;
 * failures are explicit; never emulate capabilities or unverified lineage.
 */
export function openResumePicker(): void {
	setState("modal", "sessions");
	setResumeAmbiguous(null);
	setResumeNotice(null);
	setResumeError(null);
	refreshResumeCapabilities();
	void searchResume("");
}

/**
 * ID/prefix search, pinned-first. The session owns ordering (the pins file
 * is server-owned); this mirror only renders what the server returns.
 */
let resumeSearchSequence = 0;
export function searchResume(query: string): Promise<void> {
	const sequence = ++resumeSearchSequence;
	setResumeQuery(query);
	setResumeAmbiguous(null);
	setResumeLoading(true);
	setResumeError(null);
	const allProjects = resumeAllProjects();
	return call("resumeList", [{ query, limit: 200, allProjects }])
		.then((data) => {
			if (sequence !== resumeSearchSequence) return;
			const root = asRecord(data);
			const pinned = new Set(asIdList(root !== null ? root.pinnedIds : undefined));
			setResumePinnedIds([...pinned]);
			setResumeCandidates(normalizeCandidates(data, pinned));
			setResumeTotal(asNumber(root?.total) ?? 0);
		})
		.catch((err) => {
			if (sequence === resumeSearchSequence) setResumeError(errText(err));
		})
		.finally(() => {
			if (sequence === resumeSearchSequence) setResumeLoading(false);
		});
}

/**
 * Sessions across every project, for the command palette. Unlike `searchResume`
 * it leaves the picker's query, list and scope alone.
 */
export async function searchAllProjectSessions(query: string): Promise<ResumeCandidate[]> {
	const data = await call("resumeList", [{ query, limit: 200, allProjects: true }]);
	const root = asRecord(data);
	const pinned = new Set(asIdList(root !== null ? root.pinnedIds : undefined));
	return normalizeCandidates(data, pinned);
}

/**
 * Toggle the "All projects" scope. The choice persists in localStorage and the
 * current query re-runs at once so the list reflects it.
 */
export function setResumeAllProjects(on: boolean): Promise<void> {
	setAllProjectsFlag(on);
	if (typeof localStorage !== "undefined")
		localStorage.setItem("omp.resumeAllProjects", String(on));
	return searchResume(resumeQuery());
}

/** Close the picker; in-flight work keeps its own deadline, never forced. */
export function closeResumePicker(): void {
	setResumeAmbiguous(null);
}

/**
 * Resolve `arg` then wake/switch via the EXISTING roster path (never a
 * parallel attachment): unique -> resumeSession/switchSession;
 * ambiguous -> show the choice list; refused/missing -> show the reason.
 * Bare/empty input opens the picker (G20.1).
 */
export function chooseResumeTarget(
	arg: string,
	workspaceId?: string,
): Promise<ResumeResolveOutcome> {
	const trimmed = arg.trim();
	if (trimmed.length === 0) {
		openResumePicker();
		return Promise.resolve({ kind: "unknown", message: "Opened the resume picker." });
	}
	if (workspaceId) {
		return requestWorkspaceSessions(workspaceId)
			.then(async (rows) => {
				const q = trimmed.toLowerCase();
				const matches = rows.filter((row) => {
					const filename =
						row.path
							.split(/[\\/]/)
							.pop()
							?.replace(/\.jsonl$/i, "")
							.toLowerCase() ?? "";
					return (
						row.id.toLowerCase().startsWith(q) ||
						filename.startsWith(q) ||
						filename.slice(filename.lastIndexOf("_") + 1).startsWith(q) ||
						row.path === trimmed
					);
				});
				const candidates = normalizeCandidates(matches, new Set(resumePinnedIds()));
				if (candidates.length === 1 && candidates[0]) {
					await resumeViaRoster(candidates[0], workspaceId);
					return { kind: "unique", session: candidates[0] } as ResumeResolveOutcome;
				}
				if (candidates.length > 1) {
					setResumeAmbiguous(candidates);
					setState("modal", "sessions");
					return { kind: "ambiguous", candidates } as ResumeResolveOutcome;
				}
				throw new Error(
					"No authorized session matches in the selected profile/workspace/directory.",
				);
			})
			.catch((err) => {
				const message = errText(err);
				setResumeError(message);
				return { kind: "refused", message } as ResumeResolveOutcome;
			});
	}
	// resumeResolve runs inside an attached session. With none attached the edge answers
	// "not attached" and the call parks until its 30 s deadline, so fail at once with the cause.
	if (state.currentWorkspaceId === "") {
		const message =
			"No workspace is open. Open a workspace in Chat first, then resume this session.";
		setResumeError(message);
		return Promise.resolve({ kind: "refused", message });
	}
	return call("resumeResolve", [{ arg: trimmed }])
		.then(async (data) => {
			const root = asRecord(data);
			const kind = root !== null ? asString(root.kind) : undefined;
			const pinned = new Set<string>(asIdList(root?.pinnedIds));
			if (kind === "unique") {
				const session = normalizeCandidate(root?.session, pinned);
				if (session === null) {
					const outcome: ResumeResolveOutcome = {
						kind: "unknown",
						message: "The server returned an unusable resume target.",
					};
					setResumeError(outcome.message);
					return outcome;
				}
				setResumeAmbiguous(null);
				await resumeViaRoster(session, workspaceId);
				const outcome: ResumeResolveOutcome = { kind: "unique", session };
				return outcome;
			}
			if (kind === "ambiguous") {
				const raw = root !== null && Array.isArray(root.candidates) ? root.candidates : [];
				const candidates = normalizeCandidates(raw, pinned);
				setResumeAmbiguous(candidates);
				setState("modal", "sessions");
				const outcome: ResumeResolveOutcome = { kind: "ambiguous", candidates };
				return outcome;
			}
			if (kind === "missing") {
				const searched = root !== null ? (asNumber(root.searched) ?? 0) : 0;
				const outcome: ResumeResolveOutcome = {
					kind: "missing",
					searched,
				};
				setResumeError(`No session matches "${trimmed}" (${searched} searched).`);
				return outcome;
			}
			if (kind === "refused") {
				const message = asString(root?.message) ?? `Resume of "${trimmed}" was refused.`;
				const outcome: ResumeResolveOutcome = { kind: "refused", message };
				setResumeError(message);
				return outcome;
			}
			const outcome: ResumeResolveOutcome = {
				kind: "unknown",
				message: "Unexpected resume response.",
			};
			setResumeError(outcome.message);
			return outcome;
		})
		.catch((err) => {
			const outcome: ResumeResolveOutcome = { kind: "refused", message: errText(err) };
			setResumeError(outcome.message);
			return outcome;
		});
}

/**
 * Wake/switch through the existing roster path: an asleep session wakes via
 * spawn_resume + attach; a ready one attaches then switchSession. A folder that
 * only a registered project owns starts that project's session first
 * (spawnProjectSession). A folder no registered project owns is refused with a
 * pointer to Add project. No new attachment mechanism, no parallel session.
 */
async function resumeViaRoster(session: ResumeCandidate, workspaceId?: string): Promise<void> {
	if (workspaceId) {
		const chosen = state.sessionRoster.find((entry) => entry.workspaceId === workspaceId);
		if (!chosen || (session.cwd && chosen.cwd !== session.cwd)) {
			throw new Error(
				"Select the owning profile/workspace/directory in the roster before resuming this session.",
			);
		}
		await resumeSession(chosen.workspaceId, session.sessionFile);
	} else if (session.cwd) {
		const owner = resolveSessionOwner(session.cwd, {
			roster: state.sessionRoster,
			projects: state.registeredProjects,
		});
		switch (owner.kind) {
			case "workspace":
				await resumeSession(owner.workspaceId, session.sessionFile);
				break;
			case "project":
				spawnProjectSession(session.cwd, session.sessionFile);
				break;
			case "ambiguous":
				throw new Error(
					"Select the owning profile/workspace/directory in the roster before resuming this session.",
				);
			case "none":
				throw new Error(
					`No registered project owns ${session.cwd}. Use Add project to register it before resuming this session.`,
				);
		}
	} else {
		const result = await call("switchSession", [session.sessionFile]);
		if (asRecord(result)?.cancelled === true)
			throw new Error("Session switch cancelled by extension");
	}
	closeResumePicker();
}

/** Request a workspace's last sessions for disambiguating cross-session picks. */
export function requestResumeWorkspaceSessions(workspaceId: string): Promise<SessionListEntry[]> {
	return requestWorkspaceSessions(workspaceId);
}

/** Picker rows from the mirrored candidates; `current` marks the attached session. */
export function sessionRowsFromResume(
	candidates: readonly ResumeCandidate[],
	attachedFile: string | undefined,
): SessionRow[] {
	return candidates.map((c) => {
		const blocked = unownedFolderBlock(c.cwd);
		return {
			id: c.id,
			file: c.sessionFile,
			...(c.title !== undefined ? { title: c.title } : {}),
			cwd: c.cwd,
			projectLabel: projectLabelFromCwd(c.cwd),
			...(c.createdMs !== undefined ? { createdMs: c.createdMs } : {}),
			modifiedMs: c.modifiedMs,
			messageCount: c.messageCount,
			...(c.status !== undefined ? { status: c.status } : {}),
			...(c.firstMessage !== undefined ? { firstMessage: c.firstMessage } : {}),
			...(c.recentText !== undefined ? { recentText: c.recentText } : {}),
			pinned: c.pinned,
			scope: c.scope,
			current: c.sessionFile === attachedFile,
			...(blocked ? { blocked } : {}),
		};
	});
}

/** A folder no registered project owns cannot resume until it is added as a project. */
function unownedFolderBlock(cwd: string): SessionRow["blocked"] | undefined {
	if (!cwd) return undefined;
	const owner = resolveSessionOwner(cwd, {
		roster: state.sessionRoster,
		projects: state.registeredProjects,
	});
	if (owner.kind !== "none") return undefined;
	return {
		reason: "No registered project owns this folder. Add it as a project to resume.",
		addProjectPath: trimTrailingSlashes(cwd),
	};
}

/**
 * Delete one session the user confirmed. The attached session goes through
 * `deleteSession` (the session replaces it); any other session goes through
 * `resumeDelete`, which the session validates (jail, listing, header id, writer
 * lease). Client refusals and session errors surface as the picker error.
 */
export function deleteResumeSession(
	row: Pick<SessionRow, "id" | "file" | "current">,
): Promise<boolean> {
	const check = validateSessionDelete(row, {
		attachedFile: state.sessionFile ?? null,
		manageAvailable: resumeCapabilities()?.manage === true,
	});
	if (!check.ok) {
		setResumeError(check.reason);
		return Promise.resolve(false);
	}
	setResumeLoading(true);
	setResumeError(null);
	const request = check.current
		? call("deleteSession")
		: call("resumeDelete", [{ sessionFile: row.file, sessionId: row.id }]);
	return request
		.then(() => {
			setResumeCandidates((prev) => prev.filter((c) => c.id !== row.id));
			setResumePinnedIds((prev) => prev.filter((id) => id !== row.id));
			if (!check.current) setResumeTotal((prev) => Math.max(0, prev - 1));
			setResumeNotice("Session deleted.");
			if (check.current) void searchResume(resumeQuery());
			return true;
		})
		.catch((err) => {
			setResumeError(errText(err));
			return false;
		})
		.finally(() => setResumeLoading(false));
}

/**
 * Rename one session. The session trims and validates the title and handles the
 * attached session and every other session alike.
 */
export function renameResumeSession(
	row: Pick<SessionRow, "id" | "file">,
	rawTitle: string,
): Promise<boolean> {
	const title = normalizeSessionTitle(rawTitle);
	if (title === null) {
		setResumeError("Session names must be 1 to 200 characters on one line.");
		return Promise.resolve(false);
	}
	setResumeLoading(true);
	setResumeError(null);
	return call("resumeRename", [{ sessionFile: row.file, title }])
		.then((data) => {
			const saved = asString(asRecord(data)?.title) ?? title;
			setResumeCandidates((prev) =>
				prev.map((c) => (c.id === row.id ? { ...c, title: saved } : c)),
			);
			return true;
		})
		.catch((err) => {
			setResumeError(errText(err));
			return false;
		})
		.finally(() => setResumeLoading(false));
}
