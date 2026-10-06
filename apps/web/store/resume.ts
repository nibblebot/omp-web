import type { SessionListEntry } from "#lib/wire/protocol";
import { call, state, setState } from "../state";
import { api } from "../tx/api";
import { requestDaemonSessions, resumeDaemonSession } from "./roster";

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
	status?: string;
	firstMessage?: string;
	pinned: boolean;
	scope: "local" | "global";
}

export interface ForeignSessionPreview {
	source: "claude" | "codex";
	sourceName: string;
	id: string;
	path: string;
	cwd: string;
	title?: string;
	createdMs: number;
	modifiedMs: number;
	messageCount: number;
	firstMessage?: string;
	staged?: boolean;
}

export interface ImportedForeignSession {
	sessionId: string;
	sessionFile: string;
	provenance: {
		source: string;
		sourceName: string;
		sourceId: string;
		sourcePath: string;
		sourceCwd: string;
		stagedUpload: boolean;
	};
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

/** Pre-P0 server: the method itself does not exist — fall back, never hang. */
function isUnknownMethod(err: unknown): boolean {
	return /unknown method|no such method|method not found|unknown call|not implemented/i.test(
		errText(err),
	);
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
		...(asString(r.status) !== undefined ? { status: asString(r.status) } : {}),
		...(asString(r.firstMessage) !== undefined ? { firstMessage: asString(r.firstMessage) } : {}),
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

function normalizeForeignPreview(value: unknown): ForeignSessionPreview | null {
	const r = asRecord(value);
	if (r === null) return null;
	const source = asString(r.source);
	if (source !== "claude" && source !== "codex") return null;
	const id = asString(r.id);
	if (!id) return null;
	return {
		source,
		sourceName: asString(r.sourceName) ?? (source === "claude" ? "Claude" : "Codex"),
		id,
		path: asString(r.path) ?? "",
		cwd: asString(r.cwd) ?? "",
		...(asString(r.title) !== undefined ? { title: asString(r.title) } : {}),
		createdMs: asNumber(r.createdMs) ?? 0,
		modifiedMs: asNumber(r.modifiedMs) ?? 0,
		messageCount: asNumber(r.messageCount) ?? 0,
		...(asString(r.firstMessage) !== undefined ? { firstMessage: asString(r.firstMessage) } : {}),
		...(asBoolean(r.staged) === true ? { staged: true as const } : {}),
	};
}

// ---------------------------------------------------------------------------
// Mirrors in the application's one Solid store.
// ---------------------------------------------------------------------------

export interface ResumeState {
	candidates: ResumeCandidate[];
	pinnedIds: string[];
	query: string;
	pickerOpen: boolean;
	ambiguous: ResumeCandidate[] | null;
	loading: boolean;
	error: string | null;
	notice: string | null;
	capabilities: Record<string, boolean> | null;
	unavailable: string | null;
	importSource: "claude" | "codex";
	importCandidates: ForeignSessionPreview[];
	importPreview: ForeignSessionPreview | null;
	importLoading: boolean;
	importError: string | null;
	importStagedId: string | null;
	cloneRequest: {
		workspaceId: string;
		sessionId: string;
		resumeClonePath: string;
		warning: string;
	} | null;
}

export function createResumeState(): ResumeState {
	return {
		candidates: [] as ResumeCandidate[],
		pinnedIds: [] as string[],
		query: "",
		pickerOpen: false,
		ambiguous: null as ResumeCandidate[] | null,
		loading: false,
		error: null as string | null,
		notice: null as string | null,
		capabilities: null as Record<string, boolean> | null,
		unavailable: null as string | null,
		importSource: "claude" as "claude" | "codex",
		importCandidates: [] as ForeignSessionPreview[],
		importPreview: null as ForeignSessionPreview | null,
		importLoading: false,
		importError: null as string | null,
		importStagedId: null as string | null,
		cloneRequest: null as {
			workspaceId: string;
			sessionId: string;
			resumeClonePath: string;
			warning: string;
		} | null,
	};
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
const [resumePickerOpen, setResumePickerOpen] = resumeField("pickerOpen");
const [resumeAmbiguous, setResumeAmbiguous] = resumeField("ambiguous");
const [resumeLoading, setResumeLoading] = resumeField("loading");
const [resumeError, setResumeError] = resumeField("error");
const [resumeNotice, setResumeNotice] = resumeField("notice");
const [resumeCapabilities, setResumeCapabilities] = resumeField("capabilities");
const [resumeUnavailable, setResumeUnavailable] = resumeField("unavailable");
const [importSource, setImportSource] = resumeField("importSource");
const [importCandidates, setImportCandidates] = resumeField("importCandidates");
const [importPreview, setImportPreview] = resumeField("importPreview");
const [importLoading, setImportLoading] = resumeField("importLoading");
const [importError, setImportError] = resumeField("importError");
const [importStagedId, setImportStagedId] = resumeField("importStagedId");
export const [resumeCloneRequest, setResumeCloneRequest] = resumeField("cloneRequest");

export {
	resumeCandidates,
	resumePinnedIds,
	resumeQuery,
	resumePickerOpen,
	resumeAmbiguous,
	resumeLoading,
	resumeError,
	resumeNotice,
	resumeCapabilities,
	resumeUnavailable,
	importSource,
	importCandidates,
	importPreview,
	importLoading,
	importError,
	importStagedId,
};

// ---------------------------------------------------------------------------
// Resume actions
// ---------------------------------------------------------------------------

/** Capability probe: unknown-method servers degrade to the legacy surface. */
export function refreshResumeCapabilities(): void {
	void call("getResumeCapabilities")
		.then((data) => {
			const root = asRecord(data);
			if (root === null) {
				setResumeCapabilities(null);
				return;
			}
			const caps: Record<string, boolean> = {};
			for (const key of ["resolve", "pins", "foreignImport", "lineage"] as const) {
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
	setResumePickerOpen(true);
	setResumeAmbiguous(null);
	setResumeNotice(null);
	setResumeError(null);
	refreshResumeCapabilities();
	void searchResume("");
}

/**
 * ID/prefix search, pinned-first. The daemon owns ordering (the pins file
 * is server-owned); this mirror only renders what the server returns.
 */
let resumeSearchSequence = 0;
export function searchResume(query: string): Promise<void> {
	const sequence = ++resumeSearchSequence;
	setResumeQuery(query);
	setResumeLoading(true);
	setResumeError(null);
	return call("resumeList", [{ query, limit: 100 }])
		.then((data) => {
			if (sequence !== resumeSearchSequence) return;
			const root = asRecord(data);
			const pinned = new Set(asIdList(root !== null ? root.pinnedIds : undefined));
			setResumePinnedIds([...pinned]);
			setResumeCandidates(normalizeCandidates(data, pinned));
		})
		.catch((err) => {
			if (sequence === resumeSearchSequence) setResumeError(errText(err));
		})
		.finally(() => {
			if (sequence === resumeSearchSequence) setResumeLoading(false);
		});
}

/** Close the picker; in-flight work keeps its own deadline, never forced. */
export function closeResumePicker(): void {
	setResumePickerOpen(false);
	setResumeAmbiguous(null);
	setImportPreview(null);
}

/**
 * Toggle one resume-list pin. UI copy MUST say "resume-list pin": it only
 * orders this picker — it is NOT a credential/account pin (automatic OAuth
 * session stickiness) and it does NOT change what the model keeps in
 * context. Unknown-method servers keep the local mirror unchanged.
 */
export function togglePin(sessionId: string): void {
	if (!sessionId) return;
	void call("resumePinToggle", [{ sessionId }])
		.then((data) => {
			const root = asRecord(data);
			const pinned = asBoolean(root?.pinned);
			setResumePinnedIds(asIdList(root?.pinnedIds));
			if (pinned !== undefined) {
				setResumeCandidates((prev) => {
					const next = prev.map((c) => (c.id === sessionId ? { ...c, pinned } : c));
					const top = next.filter((c) => c.pinned);
					const rest = next.filter((c) => !c.pinned);
					return [...top, ...rest];
				});
			}
		})
		.catch((err) => {
			setResumeError(
				isUnknownMethod(err) ? "Resume-list pins are unavailable on this server." : errText(err),
			);
		});
}

/**
 * Resolve `arg` then wake/switch via the EXISTING roster path (never a
 * parallel attachment): unique -> resumeDaemonSession/switchSession;
 * ambiguous -> show the choice list; refused/missing -> show the reason.
 * Bare/empty input opens the picker (G20.1).
 */
export function chooseResumeTarget(arg: string, daemonId?: string): Promise<ResumeResolveOutcome> {
	const trimmed = arg.trim();
	if (trimmed.length === 0) {
		openResumePicker();
		return Promise.resolve({ kind: "unknown", message: "Opened the resume picker." });
	}
	if (daemonId) {
		return requestDaemonSessions(daemonId)
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
					await resumeViaRoster(candidates[0], daemonId);
					return { kind: "unique", session: candidates[0] } as ResumeResolveOutcome;
				}
				if (candidates.length > 1) {
					setResumeAmbiguous(candidates);
					setResumePickerOpen(true);
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
				await resumeViaRoster(session, daemonId);
				const outcome: ResumeResolveOutcome = { kind: "unique", session };
				return outcome;
			}
			if (kind === "ambiguous") {
				const raw = root !== null && Array.isArray(root.candidates) ? root.candidates : [];
				const candidates = normalizeCandidates(raw, pinned);
				setResumeAmbiguous(candidates);
				setResumePickerOpen(true);
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
 * Wake/switch through the existing roster path: an asleep daemon wakes via
 * spawn_resume + attach; a ready one attaches then switchSession. No new
 * attachment mechanism, no parallel session.
 */
async function resumeViaRoster(session: ResumeCandidate, daemonId?: string): Promise<void> {
	const owners = state.daemonRoster.filter((entry) => entry.cwd === session.cwd);
	const owner = daemonId
		? state.daemonRoster.find((entry) => entry.daemonId === daemonId)
		: owners.length === 1
			? owners[0]
			: undefined;
	if (session.cwd && (!owner || owner.cwd !== session.cwd)) {
		throw new Error(
			"Select the owning profile/workspace/directory in the roster before resuming this session.",
		);
	}
	if (owner) {
		await resumeDaemonSession(owner.daemonId, session.sessionFile);
	} else {
		const result = await call("switchSession", [session.sessionFile]);
		if (asRecord(result)?.cancelled === true)
			throw new Error("Session switch cancelled by extension");
	}
	closeResumePicker();
}

// ---------------------------------------------------------------------------
// Foreign import actions
// ---------------------------------------------------------------------------

/** Switch the source picker (Claude/Codex); clears preview/selection. */
export function setForeignSource(source: "claude" | "codex"): void {
	cancelImport();
	setImportSource(source);
	setImportPreview(null);
	setImportError(null);
	setImportStagedId(null);
	void listForeign(source);
}

/**
 * List foreign sessions (metadata only; authorized fleet-host roots or the
 * default source location). Unknown-method servers report unavailable.
 */
export function listForeign(source: "claude" | "codex", root?: string): Promise<void> {
	setImportLoading(true);
	setImportError(null);
	return call("foreignList", [root !== undefined ? { source, root } : { source }])
		.then((data) => {
			const rootRec = asRecord(data);
			const list = rootRec !== null && Array.isArray(rootRec.sessions) ? rootRec.sessions : data;
			const out: ForeignSessionPreview[] = [];
			if (Array.isArray(list)) {
				for (const item of list) {
					const p = normalizeForeignPreview(item);
					if (p !== null) out.push(p);
				}
			}
			setImportCandidates(out);
		})
		.catch((err) => {
			setImportError(
				isUnknownMethod(err)
					? `Foreign import from ${source} is unavailable on this server.`
					: errText(err),
			);
		})
		.finally(() => setImportLoading(false));
}

/**
 * Preview one foreign session: title/cwd/created/modified/messageCount/
 * firstMessage only — the full transcript is never loaded for preview.
 */
export function previewImport(id: string): void {
	if (!id) return;
	setImportLoading(true);
	setImportError(null);
	const source = importSource();
	void call("foreignPreview", [{ source, id }])
		.then((data) => {
			const preview = normalizeForeignPreview(data);
			if (preview === null) {
				setImportError("The server returned an unusable foreign preview.");
				return;
			}
			setImportPreview(preview);
			if (preview.staged === true) setImportStagedId(preview.id);
		})
		.catch((err) => setImportError(errText(err)))
		.finally(() => setImportLoading(false));
}

/**
 * Confirm the import: a NEW native session identity + a provenance line
 * (`foreign_session_import`: source/sourceId/sourcePath/sourceCwd). The
 * foreign original is never mutated; the new session resumes via the
 * existing switchSession path.
 */
export function confirmImport(
	id: string,
	fallbackCwd?: string,
): Promise<ImportedForeignSession | null> {
	if (!id) return Promise.resolve(null);
	setImportLoading(true);
	setImportError(null);
	const source = importSource();
	return call("foreignImport", [
		fallbackCwd !== undefined ? { source, id, fallbackCwd } : { source, id },
	])
		.then(async (data) => {
			const root = asRecord(data);
			const sessionId = asString(root?.sessionId);
			const sessionFile = asString(root?.sessionFile);
			if (root === null || !sessionId || !sessionFile) {
				setImportError("The server returned an unusable import result.");
				return null;
			}
			const prov = asRecord(root.provenance);
			const imported: ImportedForeignSession = {
				sessionId,
				sessionFile,
				provenance: {
					source: asString(prov?.source) ?? source,
					sourceName: asString(prov?.sourceName) ?? source,
					sourceId: asString(prov?.sourceId) ?? id,
					sourcePath: asString(prov?.sourcePath) ?? "",
					sourceCwd: asString(prov?.sourceCwd) ?? "",
					stagedUpload: asBoolean(prov?.stagedUpload) ?? false,
				},
			};
			setImportStagedId(null);
			setImportPreview(null);
			setResumeNotice(
				`Imported ${imported.provenance.sourceName} session as a new native session (provenance recorded).`,
			);
			await resumeViaRoster({
				id: sessionId,
				sessionFile,
				cwd: "",
				modifiedMs: Date.now(),
				messageCount: 0,
				pinned: false,
				scope: "local",
			});
			return imported;
		})
		.catch((err) => {
			setImportError(errText(err));
			return null;
		})
		.finally(() => setImportLoading(false));
}

/** Cancel the in-flight import preview/selection (staged uploads discarded). */
export function cancelImport(): void {
	const stagedId = importStagedId();
	setImportPreview(null);
	setImportStagedId(null);
	setImportError(null);
	if (stagedId === null) return;
	void call("foreignUploadCancel", [{ stagedId }]).catch((err) => setImportError(errText(err)));
}
/** Report local upload read failures without allocating a rejected payload. */
export function reportImportError(message: string): void {
	setImportError(message);
}

/**
 * Stage user-selected file bytes for upload import. Client-side pre-checks
 * (extension/size) mirror the server's authoritative validation; the server
 * re-validates (JSONL-ish, 64 MiB cap, no executables/symlinks).
 */
export function stageUpload(
	source: "claude" | "codex",
	filename: string,
	bytes: Uint8Array,
): Promise<void> {
	cancelImport();
	const ext = filename.toLowerCase().slice(filename.toLowerCase().lastIndexOf("."));
	if (ext !== ".jsonl" && ext !== ".json") {
		setImportError(`Unsupported upload type "${ext || "(none)"}": expected .jsonl or .json.`);
		return Promise.resolve();
	}
	if (bytes.length > 64 * 1024 * 1024) {
		setImportError("Uploaded file exceeds the 64 MiB import cap.");
		return Promise.resolve();
	}
	setImportLoading(true);
	setImportError(null);
	let bytesBase64 = "";
	try {
		let binary = "";
		const chunk = 0x8000;
		for (let i = 0; i < bytes.length; i += chunk) {
			binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
		}
		bytesBase64 = btoa(binary);
	} catch {
		setImportLoading(false);
		setImportError("Could not read the selected file.");
		return Promise.resolve();
	}
	return call("foreignUploadStage", [{ source, filename, bytesBase64 }])
		.then((data) => {
			const root = asRecord(data);
			const stagedId = asString(root?.stagedId);
			const preview = normalizeForeignPreview(root?.preview);
			if (!stagedId || preview === null) {
				setImportError("The server returned an unusable staged upload.");
				return;
			}
			setImportStagedId(stagedId);
			setImportPreview({ ...preview, staged: true });
		})
		.catch((err) => setImportError(errText(err)))
		.finally(() => setImportLoading(false));
}

// ---------------------------------------------------------------------------
// Lineage-aware resume (deleted-workspace -> resume-onto-fresh-clone)
// ---------------------------------------------------------------------------

/**
 * Resume with verified materialization. Warm sessions resolve directly;
 * cold ones materialize via the daemon's callback pair (the server refuses
 * `unavailable` when no pair is active). Deleted workspaces NEVER resume
 * here — the caller gets the explicit resume-onto-fresh-clone path plus the
 * uncommitted-file warning, and the fleet resume-clone route owns the
 * mutation. Stored browsing never calls this, so it never wakes compute.
 */
export function resumeWithLineage(
	sessionId: string,
	options?: { workspaceId?: string; daemonId?: string },
): Promise<void> {
	if (!sessionId) {
		setResumeError("resumeWithLineage requires a sessionId");
		return Promise.resolve();
	}
	setResumeLoading(true);
	setResumeError(null);
	const workspaceId = options?.workspaceId;
	return call("lineageResume", [
		workspaceId !== undefined ? { sessionId, workspaceId } : { sessionId },
	])
		.then(async (data) => {
			const root = asRecord(data);
			if (root?.kind === "ready") {
				const sessionFile = asString(root.sessionFile);
				if (!sessionFile) {
					setResumeError("The server returned a ready lineage result without a session file.");
					return;
				}
				await resumeViaRoster(
					{
						id: sessionId,
						sessionFile,
						cwd: "",
						modifiedMs: 0,
						messageCount: 0,
						pinned: false,
						scope: "local",
					},
					options?.daemonId,
				);
				return;
			}
			const reason = asString(root?.reason) ?? "unavailable";
			const message = asString(root?.message) ?? "Lineage resume was refused.";
			const resumeClonePath = asString(root?.resumeClonePath);
			const warning = asString(root?.warning);
			if (reason === "deleted-workspace") {
				if (workspaceId && resumeClonePath) {
					setResumeCloneRequest({
						workspaceId,
						sessionId,
						resumeClonePath,
						warning:
							warning ??
							"Uncommitted files are unrecoverable — transcript only, onto a fresh clone at the pinned commit.",
					});
					setResumePickerOpen(true);
				}
				setResumeError(message);
				return;
			}
			setResumeError(message);
		})
		.catch((err) => setResumeError(errText(err)))
		.finally(() => setResumeLoading(false));
}

/**
 * Orphaned-only resume-onto-fresh-clone (deleted workspaces ONLY — the ONLY
 * resume affordance for stored history; fleet-stored browsing never offers
 * inline Resume). Reuses the existing api.resumeClone (POST
 * /ctl/workspaces/:id/resume-clone, server-issued resumeClonePath). Shows
 * the explicit uncommitted-file warning before issuing the mutation.
 */
export function resumeStoredClone(
	workspaceId: string,
	sessionId: string,
	resumeClonePath: string,
	profileId?: string,
): Promise<Record<string, unknown> | null> {
	if (!resumeClonePath) {
		setResumeError("resumeStoredClone requires the server-issued resumeClonePath");
		return Promise.resolve(null);
	}
	setResumeLoading(true);
	setResumeError(null);
	setResumeNotice(
		"Resuming onto a fresh clone at the pinned commit. " +
			"Uncommitted files from the deleted workspace are unrecoverable — transcript only.",
	);
	return api
		.resumeClone(resumeClonePath, sessionId, profileId)
		.then((result) => {
			setResumeCloneRequest(null);
			setResumeNotice(`Resume-onto-fresh-clone started for workspace ${workspaceId}.`);
			return result;
		})
		.catch((err) => {
			setResumeError(errText(err));
			return null;
		})
		.finally(() => setResumeLoading(false));
}

/** Request a daemon's last sessions for disambiguating cross-daemon picks. */
export function requestResumeDaemonSessions(daemonId: string): Promise<SessionListEntry[]> {
	return requestDaemonSessions(daemonId);
}
