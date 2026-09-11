import { createHash } from "node:crypto";
import { closeSync, mkdtempSync, openSync, readSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { callbackError, QUIESCE_EVIDENCE_MAX_BYTES } from "../shared/callback-protocol";
import type {
	CallbackErrorCode,
	CloneGitEvidence,
	FlushBoundary,
	QuiesceEvidence,
} from "../shared/callback-protocol";
import type { ManifestFile, ManifestFileKind } from "../shared/archive-manifest";
import { planSessionExport, verifyJsonlStructure } from "../runtime/export-sessions";
import type { SessionExportPlan } from "../runtime/export-sessions";
import type { SessionLogTailer } from "./log-tailer";

/**
 * Daemon-side quiesce evidence helpers (P4.5/P7.4/P3.5). All functions are
 * synchronous I/O on the canonical agent sessions tree + checkout git state —
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
	// Streams whose eof emission failed are NOT in the boundary — the caller
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

// ── Quiesce evidence document (P3.5) ────────────────────────────────────────

/** Inputs for the single JSON document uploaded over the bulk channel. */
export interface QuiesceEvidenceParts {
	requestId: string;
	/** POSIX relpath of the main transcript; null only when none exists anywhere. */
	mainSessionRelpath: string | null;
	boundary: FlushBoundary;
	manifestFiles: ManifestFile[];
	provenance: QuiesceEvidence["provenance"];
	writers: QuiesceEvidence["writers"];
	git: CloneGitEvidence;
}

/**
 * Assemble and serialize the evidence document, enforcing the document bound
 * (16 MiB), which is itself below the bulk channel's 64 MiB cap. A document
 * over the bound is a typed invalid_request, never a truncated upload.
 */
export function serializeQuiesceEvidence(parts: QuiesceEvidenceParts): string {
	const evidence: QuiesceEvidence = { ...parts };
	const document = JSON.stringify(evidence);
	const bytes = Buffer.byteLength(document, "utf8");
	if (bytes > QUIESCE_EVIDENCE_MAX_BYTES) {
		throw callbackError(
			"invalid_request",
			`quiesce evidence is ${bytes} bytes, over the ${QUIESCE_EVIDENCE_MAX_BYTES}-byte document bound (bulk cap is 64 MiB)`,
		);
	}
	return document;
}

/**
 * POSIX relpath of the boot main transcript under the agent sessions dir, or
 * null only when the volume holds no main transcript at all. `mainSessionFile`
 * is the boot session's absolute file (null before it is known); when it names
 * a declared main that path wins, otherwise the planner's single/lowest-sorted
 * main is used so a materialized main is never reported as absent.
 */
export function mainSessionRelpathFor(
	sessionsDir: string,
	mainSessionFile: string | null,
): string | null {
	let plan: SessionExportPlan;
	try {
		plan = planSessionExport(sessionsDir);
	} catch {
		return null;
	}
	const mains = [...plan.mainSessions.keys()].sort();
	if (mains.length === 0) return null;
	if (mainSessionFile !== null) {
		const rel = relative(sessionsDir, mainSessionFile);
		const normalized = rel.split(sep).join("/");
		if (!rel.startsWith("..") && !rel.startsWith(sep) && plan.mainSessions.has(normalized)) {
			return normalized;
		}
	}
	return mains[0]!;
}

// ── Git evidence (P7.4 / Kubernetes quiesce) ────────────────────────────────

interface GitResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

/** Operator/Pod git credential settings captured before workspace code ran. */
export interface GitCredentialSettings {
	/** Minimal environment reconstructed for every network probe. */
	env: Record<string, string>;
}

/**
 * Environment keys a network probe may reconstruct. Everything else in the
 * daemon environment stays out, so a workspace process cannot widen what the
 * probe is allowed to load.
 */
const GIT_CREDENTIAL_ENV_KEYS: readonly string[] = [
	"GIT_SSH_COMMAND",
	"GIT_SSH",
	"GIT_ASKPASS",
	"SSH_AUTH_SOCK",
	"SSH_ASKPASS",
	"GIT_CONFIG_GLOBAL",
	"OMP_GIT_SSH_PRIVATE_KEY",
	"OMP_GIT_SSH_KNOWN_HOSTS",
];

/**
 * Capture the operator/Pod credential settings a network probe may reconstruct.
 * Reads only the supplied environment (the daemon's own, frozen at exec),
 * never the workspace, so a workspace process cannot inject a credential
 * helper, askpass, or SSH command into a later probe.
 */
export function captureGitCredentialSettings(
	env: Record<string, string | undefined> = process.env,
): GitCredentialSettings {
	const captured: Record<string, string> = {};
	for (const key of GIT_CREDENTIAL_ENV_KEYS) {
		const value = env[key];
		if (typeof value === "string" && value.length > 0) captured[key] = value;
	}
	// A missing credential must fail the probe, never block on a prompt.
	captured.GIT_TERMINAL_PROMPT = "0";
	return { env: captured };
}

/**
 * Startup snapshot: captured once when this module loads, i.e. before any
 * workspace code runs. Probes reconstruct only these settings, so a later
 * mutation of the daemon environment cannot widen them.
 */
const STARTUP_CREDENTIALS = captureGitCredentialSettings();

/** Options for {@link collectGitEvidence}; absent fields select the legacy checkout-local behavior. */
export interface CollectGitEvidenceOptions {
	/** Fleet-supplied stored source URL; the checkout's raw origin must match it. */
	sourceRemote?: string;
	/** Fleet-supplied preserved pin (full lowercase commit id). */
	pinnedRevision?: string;
	/** Fleet-supplied branch. */
	branch?: string;
	/** Credential settings captured before workspace code ran. */
	credentials?: GitCredentialSettings;
}

async function runGit(
	args: string[],
	cwd: string,
	env?: Record<string, string>,
): Promise<GitResult> {
	try {
		const proc = Bun.spawn(["git", "-C", cwd, ...args], {
			stdout: "pipe",
			stderr: "pipe",
			...(env !== undefined ? { env: { PATH: process.env.PATH ?? "", ...env } } : {}),
		});
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

interface ListedRef {
	name: string;
	/** The ref's direct object (the annotated tag object for tags). */
	object: string;
	type: string;
	/** Commit-ish tip, peeled through annotated tags. */
	tip: string;
}

/** One NUL-separated record per ref: name, object, type, peeled object. */
const REF_FORMAT = "%(refname)%00%(objectname)%00%(objecttype)%00%(*objectname)";

async function listRefs(
	repoDir: string,
	namespaces: readonly string[],
	env?: Record<string, string>,
): Promise<{ ok: true; refs: ListedRef[] } | { ok: false; error: string }> {
	const res = await runGit(["for-each-ref", `--format=${REF_FORMAT}`, ...namespaces], repoDir, env);
	if (res.exitCode !== 0) {
		return { ok: false, error: res.stderr.trim() || `git for-each-ref exited ${res.exitCode}` };
	}
	const refs: ListedRef[] = [];
	for (const line of res.stdout.split("\n")) {
		if (line.length === 0) continue;
		const [name, object, type, peeled] = line.split("\0");
		if (
			name === undefined ||
			name.length === 0 ||
			object === undefined ||
			object.length === 0 ||
			type === undefined
		) {
			continue;
		}
		const tip =
			type === "commit" ? object : peeled !== undefined && peeled.length > 0 ? peeled : object;
		refs.push({ name, object, type, tip });
	}
	return { ok: true, refs };
}

/**
 * Network preservation probe. Runs from a temporary bare repository seeded
 * with the checkout's own heads, tags, and a detached HEAD commit, then
 * fetches the supplied source into a private namespace and proves each local
 * tip is contained by an advertised remote ref. Fails closed (ok:false) on
 * any git failure so the caller records `unknown`.
 */
async function probeRemotePreservation(input: {
	checkoutDir: string;
	remoteUrl: string;
	head: string;
	branch: string | null;
	localRefs: ListedRef[];
	pinnedRevision: string | undefined;
	credentials: GitCredentialSettings;
}): Promise<
	| { ok: true; refs: Array<{ name: string; tip: string; preserved: boolean }> }
	| { ok: false; error: string }
> {
	let probeDir: string | null = null;
	try {
		probeDir = mkdtempSync(join(tmpdir(), "omp-quiesce-git-"));
		// Reconstruct ONLY the captured credential settings, with a private
		// HOME so no ambient git config or credential helper is loaded.
		const env: Record<string, string> = {
			...input.credentials.env,
			HOME: probeDir,
			GIT_CONFIG_NOSYSTEM: "1",
			PATH: process.env.PATH ?? "",
		};
		const init = await runGit(["init", "--bare", "-q"], probeDir, env);
		if (init.exitCode !== 0) {
			return { ok: false, error: `probe git init failed: ${gitError(init)}` };
		}

		const importArgs = [
			"fetch",
			"-q",
			"--no-tags",
			input.checkoutDir,
			"+refs/heads/*:refs/heads/*",
			"+refs/tags/*:refs/tags/*",
		];
		if (input.branch === null) importArgs.push(input.head);
		const imported = await runGit(importArgs, probeDir, env);
		if (imported.exitCode !== 0) {
			return { ok: false, error: `probe import failed: ${gitError(imported)}` };
		}

		const fetched = await runGit(
			[
				"fetch",
				"-q",
				"--no-tags",
				"--prune",
				input.remoteUrl,
				"+refs/heads/*:refs/remotes/probe/heads/*",
				"+refs/tags/*:refs/remotes/probe/tags/*",
			],
			probeDir,
			env,
		);
		if (fetched.exitCode !== 0) {
			return { ok: false, error: `probe fetch failed: ${gitError(fetched)}` };
		}

		const remote = await listRefs(probeDir, ["refs/remotes/probe"], env);
		if (!remote.ok) return { ok: false, error: `probe refs failed: ${remote.error}` };
		const remoteObjects = new Set(remote.refs.map((ref) => ref.object));
		const remoteTips = [
			...new Set(remote.refs.map((ref) => ref.tip).filter((tip) => tip.length > 0)),
		];

		const isAncestor = async (tip: string, target: string): Promise<boolean> => {
			const res = await runGit(["merge-base", "--is-ancestor", tip, target], probeDir!, env);
			if (res.exitCode === 0) return true;
			if (res.exitCode === 1) return false;
			throw new Error(`probe merge-base failed: ${gitError(res)}`);
		};
		const isPreserved = async (tip: string, object?: string): Promise<boolean> => {
			if (remoteTips.includes(tip)) return true;
			if (object !== undefined && remoteObjects.has(object)) return true;
			for (const remoteTip of remoteTips) {
				if (await isAncestor(tip, remoteTip)) return true;
			}
			return false;
		};

		const refs: Array<{ name: string; tip: string; preserved: boolean }> = [];
		for (const ref of input.localRefs) {
			refs.push({
				name: ref.name,
				tip: ref.tip,
				preserved: await isPreserved(ref.tip, ref.object),
			});
		}
		if (input.branch === null) {
			refs.push({ name: "HEAD", tip: input.head, preserved: await isPreserved(input.head) });
		}
		if (input.pinnedRevision !== undefined) {
			if (!(await isPreserved(input.pinnedRevision))) {
				return {
					ok: false,
					error: `preserved pin ${input.pinnedRevision} is not reachable from the supplied source remote`,
				};
			}
		}
		return { ok: true, refs };
	} catch (cause) {
		return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
	} finally {
		if (probeDir !== null) {
			try {
				rmSync(probeDir, { recursive: true, force: true });
			} catch {
				// Best effort: a leaked temp probe dir is not evidence of failure.
			}
		}
	}
}

function gitError(result: GitResult): string {
	return result.stderr.trim() || `git exited ${result.exitCode}`;
}

/**
 * Collect final Git evidence with writers stopped. Every local head, tag, and
 * a detached HEAD tip is proven preserved by the source remote's advertised
 * refs. Probe failures never abort verification: they yield status "unknown"
 * with a reason, which the fleet's deletion gate treats as blocking. The
 * legacy (no `options.sourceRemote`) path keeps using the checkout's own
 * configured remote.
 */
export async function collectGitEvidence(
	checkoutDir: string,
	options: CollectGitEvidenceOptions = {},
): Promise<{
	ok: boolean;
	evidence?: CloneGitEvidence;
	error?: { code: CallbackErrorCode; message: string };
}> {
	const unknown = (reason: string): { ok: true; evidence: CloneGitEvidence } => ({
		ok: true,
		evidence: { status: "unknown", unknownReason: reason },
	});
	try {
		const credentials = options.credentials ?? STARTUP_CREDENTIALS;
		const headRes = await runGit(["rev-parse", "--verify", "HEAD^{commit}"], checkoutDir);
		if (headRes.exitCode !== 0) {
			return unknown(`cannot resolve HEAD: ${gitError(headRes)}`);
		}
		const head = headRes.stdout.trim();
		const branchRes = await runGit(["symbolic-ref", "--short", "-q", "HEAD"], checkoutDir);
		const branch =
			branchRes.exitCode === 0 && branchRes.stdout.trim().length > 0
				? branchRes.stdout.trim()
				: null;
		if (options.branch !== undefined && branch !== null && branch !== options.branch) {
			return unknown(
				`checkout branch ${JSON.stringify(branch)} does not match the stored branch ${JSON.stringify(options.branch)}`,
			);
		}

		const statusRes = await runGit(["status", "--porcelain=v1"], checkoutDir);
		if (statusRes.exitCode !== 0) {
			return unknown(`git status failed: ${gitError(statusRes)}`);
		}
		const dirtyCounts = parsePorcelain(statusRes.stdout);

		// A failed stash probe is not "zero stashes": it blocks as unknown.
		const stashRes = await runGit(["stash", "list"], checkoutDir);
		if (stashRes.exitCode !== 0) {
			return unknown(`git stash list failed: ${gitError(stashRes)}`);
		}
		const stashes = stashRes.stdout
			.trim()
			.split("\n")
			.filter((line) => line.length > 0).length;

		const refsRes = await listRefs(checkoutDir, ["refs/heads", "refs/tags"]);
		if (!refsRes.ok) return unknown(`cannot list local refs: ${refsRes.error}`);
		const localRefs = refsRes.refs;

		// RAW origin with includes disabled: a repo-local include.path (or a
		// url.<base>.insteadOf rewrite) can never masquerade as the stored
		// source the fleet pinned. Checked BEFORE any network access.
		const originRes = await runGit(
			["config", "--local", "--no-includes", "--get", "remote.origin.url"],
			checkoutDir,
		);
		const originUrl = originRes.exitCode === 0 ? originRes.stdout.trim() : null;

		let remoteName = "origin";
		let remoteUrl = originUrl !== null && originUrl.length > 0 ? originUrl : null;
		if (options.sourceRemote !== undefined) {
			if (remoteUrl === null) {
				return unknown("checkout has no configured origin to compare with the stored source");
			}
			if (remoteUrl !== options.sourceRemote) {
				return unknown(
					`checkout origin ${JSON.stringify(remoteUrl)} does not match the stored source`,
				);
			}
			remoteUrl = options.sourceRemote;
		} else if (remoteUrl === null) {
			// Legacy path: the first configured fetch remote, exactly as the
			// pre-Kubernetes evidence did.
			const remoteList = await runGit(["remote", "-v"], checkoutDir);
			for (const line of remoteList.stdout.split("\n")) {
				const match = /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(line);
				if (match) {
					remoteName = match[1]!;
					remoteUrl = match[2]!;
					break;
				}
			}
		}

		const dirty =
			dirtyCounts.added > 0 ||
			dirtyCounts.modified > 0 ||
			dirtyCounts.deleted > 0 ||
			dirtyCounts.untracked > 0;
		if (dirty || stashes > 0) {
			return {
				ok: true,
				evidence: {
					status: "dirty",
					head,
					branch,
					dirty: dirtyCounts,
					stashes,
					remote: remoteUrl !== null ? { name: remoteName, url: remoteUrl } : null,
				},
			};
		}
		if (remoteUrl === null) {
			if (localRefs.some((ref) => ref.name.startsWith("refs/heads/"))) {
				return unknown("no configured remote: local branch history cannot be verified preserved");
			}
			// No branches (fresh unborn/empty checkout) and no remote: nothing
			// to preserve; clean is provable.
			return {
				ok: true,
				evidence: {
					status: "clean",
					head,
					branch,
					dirty: dirtyCounts,
					stashes: 0,
					remote: null,
					refs: [],
				},
			};
		}

		const probe = await probeRemotePreservation({
			checkoutDir,
			remoteUrl,
			head,
			branch,
			localRefs,
			pinnedRevision: options.pinnedRevision,
			credentials,
		});
		if (!probe.ok) return unknown(probe.error);
		return {
			ok: true,
			evidence: {
				status: "clean",
				head,
				branch,
				dirty: dirtyCounts,
				stashes: 0,
				remote: { name: remoteName, url: remoteUrl },
				refs: probe.refs,
			},
		};
	} catch (cause) {
		return {
			ok: false,
			error: {
				code: "unavailable",
				message: cause instanceof Error ? cause.message : String(cause),
			},
		};
	}
}
