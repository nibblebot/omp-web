import { lstat, open, realpath } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { tryAcquireSessionLease } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { getAutonomyAdapter } from "./autonomy-adapter";
import { dropHeldQueue } from "./queue-hold";
import { exitPlanMode } from "./review-plan";
import type { SessionEntry } from "./session-entry";
import { retakeModelRolePin } from "./model-role-pin";
import { holdOutRepliesDefault } from "./out-replies-default";
import { clearSubagents } from "./subagent-mirror";

export interface LifecycleDeletionTarget {
	sessionId: string;
	sessionFile: string;
}

export interface LifecycleMirror {
	/** Authoritative current-pair/generation writable-lineage proof. */
	assertWritable(sessionId: string): Promise<void>;
	/** Acknowledged durable purge, including fencing later tailer ingestion. */
	purge(sessionId: string): Promise<void>;
}

export interface LifecycleDeps {
	sessionsDir: string;
	hasCallbackPair(): boolean;
	mirror?: LifecycleMirror;
	/** Reject stale scope/read-only lineage, even on an unpaired session. */
	assertWritable(entry: SessionEntry): Promise<void>;
	/** Cancel host dialogs/ephemeral work and drain foreground bash/python wrappers. */
	settleHostWork(entry: SessionEntry): Promise<void>;
	/** Stop/dispose active workers before crossing a conversation boundary. */
	settleWorkers(entry: SessionEntry): Promise<void>;
	broadcastAvailableCommands(entry: SessionEntry): Promise<void>;
}

export class LifecycleDeletionError extends Error {
	readonly code = "deletion_failed";
	constructor(
		message: string,
		readonly previousSessionId: string,
		readonly replacementSessionId: string,
		readonly localDeleted: boolean,
		options?: ErrorOptions,
	) {
		super(message, options);
	}
}

function isMissing(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export async function assertAbsent(path: string): Promise<void> {
	try {
		await lstat(path);
	} catch (error) {
		if (isMissing(error)) return;
		throw error;
	}
	throw new Error(`Deleted session material still exists: ${path}`);
}

/** The header is line 1-2; reading more than this prefix never changes the answer. */
const JOURNAL_HEADER_PREFIX_BYTES = 16 * 1024;

interface JournalHeaderRecord {
	type?: string;
	id?: string;
}

/** First `type: "session"` record within the journal prefix; the tail is never read or parsed. */
async function readJournalHeader(path: string): Promise<JournalHeaderRecord | undefined> {
	const handle = await open(path, "r");
	let prefix: string;
	let truncated: boolean;
	try {
		const buffer = Buffer.allocUnsafe(JOURNAL_HEADER_PREFIX_BYTES);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		prefix = buffer.toString("utf8", 0, bytesRead);
		truncated = bytesRead === buffer.length;
	} finally {
		await handle.close();
	}
	const lines = prefix.split("\n");
	// A full prefix may end mid-line; that fragment is not a record.
	if (truncated) lines.pop();
	for (const line of lines) {
		let record: JournalHeaderRecord | null;
		try {
			record = JSON.parse(line);
		} catch {
			continue;
		}
		if (record?.type === "session") return record;
	}
	return undefined;
}

/**
 * Shared jail for every destructive session-file operation (delete, rename).
 * The journal must resolve by realpath under `sessionsRoot`, be a regular
 * non-symlink `.jsonl`, carry a header id equal to `expectedSessionId`, and
 * have no unsafe artifact directory. No symlink traversal.
 */
export async function validateSessionJournal(
	sessionsRoot: string,
	sessionFile: string,
	expectedSessionId?: string,
): Promise<LifecycleDeletionTarget> {
	if (!sessionFile || !sessionFile.endsWith(".jsonl")) {
		throw new Error("Durable deletion requires a persisted file-backed session");
	}
	const root = await realpath(sessionsRoot);
	const path = resolve(sessionFile);
	const canonical = await realpath(path);
	const rel = relative(root, canonical);
	if (
		canonical !== path ||
		!rel ||
		rel === ".." ||
		rel.startsWith(`..${sep}`) ||
		resolve(root, rel) !== canonical
	) {
		throw new Error(
			"Session deletion refuses a journal outside the owned sessions root or through a symlink",
		);
	}
	const stat = await lstat(path);
	if (!stat.isFile()) throw new Error("Session deletion requires a regular main journal");
	const header = await readJournalHeader(path);
	const sessionId = header?.id;
	if (
		typeof sessionId !== "string" ||
		(expectedSessionId !== undefined && sessionId !== expectedSessionId)
	)
		throw new Error("Session journal identity does not match the requested session");
	const artifactPath = path.slice(0, -6);
	try {
		const artifactStat = await lstat(artifactPath);
		if (!artifactStat.isDirectory() || artifactStat.isSymbolicLink())
			throw new Error("Unsafe session artifact directory");
	} catch (error) {
		if (!isMissing(error)) throw error;
	}
	return { sessionId, sessionFile: path };
}

export async function syncDirectory(path: string): Promise<void> {
	const dir = await open(path, "r");
	try {
		await dir.sync();
	} finally {
		await dir.close();
	}
}

export function createLifecycleMethods(deps: LifecycleDeps) {
	const active = new WeakSet<SessionEntry>();
	async function exclusive<T>(entry: SessionEntry, run: () => Promise<T>): Promise<T> {
		if (active.has(entry)) throw new Error("Another session lifecycle operation is in progress");
		active.add(entry);
		try {
			await deps.assertWritable(entry);
			return await run();
		} finally {
			active.delete(entry);
		}
	}
	async function stop(entry: SessionEntry, workers: boolean): Promise<void> {
		// abort() awaits manual/automatic/handoff compaction cleanup; abortCompaction() alone does not.
		const host = deps.settleHostWork(entry);
		await entry.session.abort();
		await host;
		await entry.session.waitForIdle();
		if (entry.session.isBashRunning || entry.session.isEvalRunning || entry.session.isCompacting) {
			throw new Error(
				"Session lifecycle refused: foreground execution or maintenance has not settled",
			);
		}
		if (workers) await deps.settleWorkers(entry);
	}
	async function changed(entry: SessionEntry): Promise<void> {
		clearSubagents(entry);
		dropHeldQueue(entry);
		await deps.broadcastAvailableCommands(entry);
	}

	/** Brackets an SDK call that changes the transcript with the autonomy goal hooks (SDK contract). */
	async function bracketTranscript<T>(
		entry: SessionEntry,
		detachedRun: boolean,
		run: () => Promise<T>,
	): Promise<T> {
		const autonomy = getAutonomyAdapter(entry);
		await autonomy.beginSessionChange();
		try {
			return await run();
		} finally {
			await autonomy.endSessionChange({ detachedRun });
		}
	}
	return {
		clearSession: (entry: SessionEntry, _args: unknown[] = []) =>
			exclusive(entry, async () => {
				await stop(entry, true);
				const result = await bracketTranscript(entry, false, () =>
					entry.session.resetSessionContext(),
				);
				if (!result) throw new Error("Session context reset was refused by the SDK");
				await entry.session.sessionManager.flush();
				await changed(entry);
				return result;
			}),
		newSession: (entry: SessionEntry, args: unknown[] = []) =>
			exclusive(entry, async () => {
				const parent = args[0];
				if (parent !== undefined && typeof parent !== "string")
					throw new Error("Invalid parent session");
				await stop(entry, true);
				await exitPlanMode(entry);
				holdOutRepliesDefault(entry.session);
				const ok = await bracketTranscript(entry, true, () =>
					entry.session.newSession(parent ? { parentSession: parent } : undefined),
				);
				if (ok) {
					retakeModelRolePin(entry.session.settings);
					await changed(entry);
				}
				return { cancelled: !ok };
			}),
		freshSession: (entry: SessionEntry, _args: unknown[] = []) =>
			exclusive(entry, async () => {
				await stop(entry, false);
				const result = entry.session.freshSession();
				if (!result) throw new Error("Provider session reset was refused by the SDK");
				return result;
			}),
		deleteSession: (entry: SessionEntry, _args: unknown[] = []) =>
			exclusive(entry, async () => {
				// The deletion target is the attached entry, not a client-supplied ID.
				if (deps.hasCallbackPair() && !deps.mirror)
					throw new Error("Acknowledged fleet deletion is unavailable");
				await deps.mirror?.assertWritable(entry.session.sessionId);
				await stop(entry, true);
				await entry.session.sessionManager.flush();
				const target = await validateSessionJournal(
					deps.sessionsDir,
					entry.session.sessionFile ?? "",
					entry.session.sessionId,
				);
				// SDK hooks may cancel only inside newSession(). Never delete first, and never
				// use drop:true: that path catches deletion failure and logs-and-continues.
				holdOutRepliesDefault(entry.session);
				const ok = await bracketTranscript(entry, true, () => entry.session.newSession());
				if (!ok) return { cancelled: true, deleted: false, sessionId: target.sessionId };
				retakeModelRolePin(entry.session.settings);
				let localDeleted = false;
				try {
					const lease = tryAcquireSessionLease(target.sessionId);
					if (!lease) throw new Error("Session is owned by another writer");
					try {
						// Revalidate the old file after releasing the SDK's outgoing writer.
						await validateSessionJournal(deps.sessionsDir, target.sessionFile, target.sessionId);
						await entry.session.sessionManager.dropSession(target.sessionFile);
						await assertAbsent(target.sessionFile);
						await assertAbsent(target.sessionFile.slice(0, -6));
						await syncDirectory(dirname(target.sessionFile));
						localDeleted = true;
						await deps.mirror?.purge(target.sessionId);
					} finally {
						lease.release();
					}
				} catch (cause) {
					throw new LifecycleDeletionError(
						`A replacement session was created, but ${localDeleted ? "fleet purge" : "durable local deletion"} failed`,
						target.sessionId,
						entry.session.sessionId,
						localDeleted,
						{ cause },
					);
				} finally {
					await changed(entry);
				}
				return {
					cancelled: false,
					deleted: true,
					previousSessionId: target.sessionId,
					sessionId: entry.session.sessionId,
				};
			}),
	};
}
