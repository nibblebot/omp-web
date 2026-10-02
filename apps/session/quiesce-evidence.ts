import { createHash } from "node:crypto";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { callbackError } from "../../lib/wire/callback-protocol";
import type { CallbackErrorCode } from "../../lib/wire/callback-protocol";
import type { CloneGitEvidence, FlushBoundary } from "../../lib/wire/callback-protocol";
import type { ManifestFile, ManifestFileKind } from "../../lib/session-files/archive-manifest";
import { planSessionExport, verifyJsonlStructure } from "../../lib/session-files/export-sessions";
import type { SessionLogTailer } from "./log-tailer";

/**
 * Daemon-side quiesce evidence helpers (P4.5/P7.4). All functions are
 * synchronous I/O on the canonical agent sessions tree + checkout git state;
 * invoked only after the writer admission barrier is up and the session
 * cascade is disposed, so no writer can mutate the tree mid-verification.
 */

/** Stat + sha256 one lineage file for the manifest. */
export function manifestFileFor(
	sessionsDir: string,
	relToSessions: string,
	kind: ManifestFileKind,
	sessionId: string,
	parentPath?: string,
): ManifestFile {
	const absolute = join(sessionsDir, relToSessions);
	const st = statSync(absolute);
	if (!st.isFile()) {
		throw callbackError("invalid_request", `lineage path is not a regular file: ${relToSessions}`, {
			detail: absolute,
		});
	}
	return {
		path: relToSessions,
		size: st.size,
		sha256: hashFile(absolute),
		kind,
		sessionId,
		...(parentPath !== undefined ? { parentPath } : {}),
	};
}

function hashFile(absolute: string): string {
	const hash = createHash("sha256");
	const fd = openSync(absolute, "r");
	const buf = Buffer.allocUnsafe(256 * 1024);
	try {
		for (;;) {
			const got = readSync(fd, buf, 0, buf.length, null);
			if (got <= 0) break;
			hash.update(buf.subarray(0, got));
		}
	} finally {
		closeSync(fd);
	}
	return hash.digest("hex");
}

/** Enumerate every lineage file under the sessions root and produce manifest entries. */
export function enumerateLineageManifest(sessionsDir: string): ManifestFile[] {
	const plan = planSessionExport(sessionsDir);
	return plan.files
		.map((file) =>
			manifestFileFor(sessionsDir, file.relToSessions, file.kind, file.sessionId, file.parentPath),
		)
		.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * Structural verification of every declared JSONL: title slot + header +
 * newline-terminated entries, hard-blocking the SDK indeterminate-persistence
 * fingerprint (the P0.3 load-bearing predicate). Any failure is a typed
 * unavailable error (ExportError carries a ledger code).
 */
export function verifyLineageStructure(sessionsDir: string): void {
	const plan = planSessionExport(sessionsDir);
	for (const file of plan.files) {
		if (!file.relToSessions.endsWith(".jsonl")) continue;
		verifyJsonlStructure(join(sessionsDir, file.relToSessions), file.sessionId);
	}
}

/**
 * Finalize the log tailer for quiesce: freeze discovery, release torn tails
 * verbatim, emit per-stream eof, then snapshot the final flush boundary.
 * The fleet must reach exactly this boundary before the delete gate passes.
 */
export function finalizeTailerBoundary(tailer: SessionLogTailer): FlushBoundary {
	const boundary: FlushBoundary = {};
	for (const [streamId, entry] of tailer.finalizeForQuiesce()) {
		if (entry.eof)
			boundary[streamId] = { offset: entry.offset, generation: entry.generation, eof: true };
	}
	// Streams whose eof emission failed are NOT in the boundary; the caller
	// must treat a boundary that does not cover every tracked stream as an
	// explicit failure.
	const status = tailer.status();
	for (const session of status.sessions) {
		for (const stream of session.streams) {
			if (boundary[stream.streamId] === undefined) {
				throw callbackError("unavailable", `stream not finalized for quiesce: ${stream.streamId}`);
			}
		}
	}
	return boundary;
}

/**
 * True when the acked-offset map covers every stream of `boundary` at or
 * beyond its final offset (fleet durability confirmed for the whole boundary).
 */
export function boundaryAcked(
	boundary: FlushBoundary,
	acked: ReadonlyMap<string, number>,
): boolean {
	for (const [streamId, want] of Object.entries(boundary)) {
		const have = acked.get(streamId);
		if (have === undefined || have < want.offset) return false;
	}
	return true;
}

// ── Git evidence (P7.4) ─────────────────────────────────────────────────────

interface GitResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

async function runGit(args: string[], cwd: string): Promise<GitResult> {
	try {
		const proc = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		const exitCode = await proc.exited;
		return { exitCode, stdout, stderr };
	} catch (cause) {
		return {
			exitCode: -1,
			stdout: "",
			stderr: cause instanceof Error ? cause.message : String(cause),
		};
	}
}

function parsePorcelain(stdout: string): {
	added: number;
	modified: number;
	deleted: number;
	untracked: number;
} {
	let added = 0;
	let modified = 0;
	let deleted = 0;
	let untracked = 0;
	for (const line of stdout.split("\n")) {
		if (line.length === 0) continue;
		const x = line[0] ?? " ";
		const y = line[1] ?? " ";
		if (x === "?" || y === "?") untracked++;
		else if (x === "A" || y === "A") added++;
		else if (x === "D" || y === "D") deleted++;
		else if (x !== " " || y !== " ") modified++;
	}
	return { added, modified, deleted, untracked };
}

/**
 * Collect final Git evidence with writers stopped. Fails closed: any probe
 * failure (git missing, not a repo, fetch failure, remote unreachable)
 * returns ok:false with a ledger `conflict` code; deletion is blocked and
 * the workspace + volume + fleet store are retained.
 */
export async function collectGitEvidence(checkoutDir: string): Promise<{
	ok: boolean;
	evidence?: CloneGitEvidence;
	error?: { code: CallbackErrorCode; message: string };
}> {
	const fail = (
		message: string,
	): { ok: false; error: { code: CallbackErrorCode; message: string } } => ({
		ok: false,
		error: { code: "conflict", message },
	});
	try {
		const head = await runGit(["rev-parse", "HEAD"], checkoutDir);
		if (head.exitCode !== 0)
			return fail(`cannot resolve HEAD: ${head.stderr.trim() || `git exited ${head.exitCode}`}`);
		const branchResult = await runGit(["symbolic-ref", "--short", "HEAD"], checkoutDir);
		const branch =
			branchResult.exitCode === 0 && branchResult.stdout.trim().length > 0
				? branchResult.stdout.trim()
				: null;

		const status = await runGit(["status", "--porcelain=v1"], checkoutDir);
		if (status.exitCode !== 0)
			return fail(`git status failed: ${status.stderr.trim() || `git exited ${status.exitCode}`}`);
		const dirtyCounts = parsePorcelain(status.stdout);
		const stashResult = await runGit(["stash", "list"], checkoutDir);
		const stashes =
			stashResult.exitCode === 0
				? stashResult.stdout
						.trim()
						.split("\n")
						.filter((l) => l.length > 0).length
				: 0;

		const remoteResult = await runGit(["remote", "-v"], checkoutDir);
		let remote: { name: string; url: string } | null = null;
		for (const line of remoteResult.stdout.split("\n")) {
			const m = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(line);
			if (m && m[3] === "fetch") {
				remote = { name: m[1]!, url: m[2]! };
				break;
			}
		}

		const dirty =
			dirtyCounts.added > 0 ||
			dirtyCounts.modified > 0 ||
			dirtyCounts.deleted > 0 ||
			dirtyCounts.untracked > 0;
		const refResult = await runGit(
			["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads", "refs/tags"],
			checkoutDir,
		);
		if (refResult.exitCode !== 0) return fail(`cannot list refs: ${refResult.stderr.trim()}`);
		const localRefs: Array<{ name: string; tip: string }> = [];
		for (const line of refResult.stdout.split("\n")) {
			const sp = line.indexOf(" ");
			if (sp < 0) continue;
			localRefs.push({ name: line.slice(0, sp), tip: line.slice(sp + 1).trim() });
		}

		if (dirty || stashes > 0) {
			return {
				ok: true,
				evidence: {
					status: "dirty",
					head: head.stdout.trim(),
					branch,
					dirty: dirtyCounts,
					stashes,
					remote,
				},
			};
		}
		if (remote === null) {
			if (localRefs.some((r) => r.name.startsWith("refs/heads/"))) {
				return fail("no configured remote: local branch history cannot be verified preserved");
			}
			// No branches (fresh unborn/empty checkout) and no remote: nothing
			// to preserve; clean is provable.
			return {
				ok: true,
				evidence: {
					status: "clean",
					head: head.stdout.trim(),
					branch,
					dirty: dirtyCounts,
					stashes: 0,
					remote: null,
					refs: [],
				},
			};
		}

		// Preservation on the configured remote: fetch, then prove every local
		// tip is an ancestor of its remote counterpart (nothing unpushed).
		const fetch = await runGit(["fetch", remote.name], checkoutDir);
		if (fetch.exitCode !== 0)
			return fail(
				`cannot fetch ${remote.name}: ${fetch.stderr.trim() || `git exited ${fetch.exitCode}`}`,
			);
		const preserved: Array<{ name: string; tip: string; preserved: boolean }> = [];
		for (const ref of localRefs) {
			const candidate = ref.name.startsWith("refs/heads/")
				? `refs/remotes/${remote.name}/${ref.name.slice("refs/heads/".length)}`
				: `refs/remotes/${remote.name}/tags/${ref.name.slice("refs/tags/".length)}`;
			const remoteRef = await runGit(
				["rev-parse", "--verify", `${candidate}^{commit}`],
				checkoutDir,
			);
			if (remoteRef.exitCode !== 0) {
				preserved.push({ name: ref.name, tip: ref.tip, preserved: false });
				continue;
			}
			const ancestor = await runGit(
				["merge-base", "--is-ancestor", ref.tip, remoteRef.stdout.trim()],
				checkoutDir,
			);
			preserved.push({ name: ref.name, tip: ref.tip, preserved: ancestor.exitCode === 0 });
		}
		const unpreserved = preserved.filter((p) => !p.preserved);
		if (unpreserved.length > 0) {
			return {
				ok: true,
				evidence: {
					status: "dirty",
					head: head.stdout.trim(),
					branch,
					dirty: dirtyCounts,
					stashes,
					remote,
					refs: preserved,
				},
			};
		}
		return {
			ok: true,
			evidence: {
				status: "clean",
				head: head.stdout.trim(),
				branch,
				dirty: dirtyCounts,
				stashes,
				remote,
				refs: preserved,
			},
		};
	} catch (cause) {
		return fail(cause instanceof Error ? cause.message : String(cause));
	}
}
