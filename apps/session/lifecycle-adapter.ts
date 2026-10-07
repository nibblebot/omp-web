import { lstat, open, readFile, realpath } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { tryAcquireSessionLease } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import type { SessionEntry } from "./session-entry";
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
	/** Reject stale scope/read-only lineage, even on an unpaired daemon. */
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

async function assertAbsent(path: string): Promise<void> {
	try {
		await lstat(path);
	} catch (error) {
		if (isMissing(error)) return;
		throw error;
	}
	throw new Error(`Deleted session material still exists: ${path}`);
}

/** Only a real, managed, matching main journal can be destroyed. No symlink traversal. */
async function deletionTarget(
	entry: SessionEntry,
	sessionsDir: string,
): Promise<LifecycleDeletionTarget> {
	const sessionFile = entry.session.sessionFile;
	if (!sessionFile || !sessionFile.endsWith(".jsonl")) {
		throw new Error("Durable deletion requires a persisted file-backed session");
	}
	const root = await realpath(sessionsDir);
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
	const content = await readFile(path, "utf8");
	const header = content
		.split("\n")
		.map((line) => {
			try {
				return JSON.parse(line) as { type?: string; id?: string };
			} catch {
				return null;
			}
		})
		.find((record) => record?.type === "session");
	if (header?.id !== entry.session.sessionId)
		throw new Error("Session journal identity does not match the attached session");
	const artifactPath = path.slice(0, -6);
	try {
		const artifactStat = await lstat(artifactPath);
		if (!artifactStat.isDirectory() || artifactStat.isSymbolicLink())
			throw new Error("Unsafe session artifact directory");
	} catch (error) {
		if (!isMissing(error)) throw error;
	}
	return { sessionId: entry.session.sessionId, sessionFile: path };
}

async function syncDirectory(path: string): Promise<void> {
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
		await deps.broadcastAvailableCommands(entry);
	}
	return {
		clearSession: (entry: SessionEntry, _args: unknown[] = []) =>
			exclusive(entry, async () => {
				await stop(entry, true);
				const result = await entry.session.resetSessionContext();
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
				const ok = await entry.session.newSession(parent ? { parentSession: parent } : undefined);
				if (ok) await changed(entry);
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
				const target = await deletionTarget(entry, deps.sessionsDir);
				// SDK hooks may cancel only inside newSession(). Never delete first, and never
				// use drop:true: that path catches deletion failure and logs-and-continues.
				const ok = await entry.session.newSession();
				if (!ok) return { cancelled: true, deleted: false, sessionId: target.sessionId };
				let localDeleted = false;
				try {
					const lease = tryAcquireSessionLease(target.sessionId);
					if (!lease) throw new Error("Session is owned by another writer");
					try {
						// Revalidate the old file after releasing the SDK's outgoing writer.
						const oldEntry = {
							session: { sessionFile: target.sessionFile, sessionId: target.sessionId },
						} as SessionEntry;
						await deletionTarget(oldEntry, deps.sessionsDir);
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
