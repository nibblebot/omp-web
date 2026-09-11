import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallbackErrorCode, CloneGitEvidence } from "../shared/callback-protocol";

/**
 * Git preservation evidence for the quiesce delete gate (P7.4). Every command
 * is launched from a frozen Git surface captured when this module loads —
 * executable path, PATH, credential settings — so workspace code that later
 * mutates `process.env` (GIT_DIR/GIT_WORK_TREE to a decoy checkout, PATH to a
 * decoy git, GIT_CONFIG_* to injected config) cannot redirect a probe.
 */

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
 * probe is allowed to load. There is deliberately no GIT_CONFIG_GLOBAL: it is
 * a mutable path whose contents (include.path, url.<base>.insteadOf rewrites,
 * core.hooksPath) the probe would honor after workspace code ran. Operator
 * auth travels through the explicit SSH/askpass settings below.
 */
const GIT_CREDENTIAL_ENV_KEYS: readonly string[] = [
	"GIT_SSH_COMMAND",
	"GIT_SSH",
	"GIT_ASKPASS",
	"SSH_AUTH_SOCK",
	"SSH_ASKPASS",
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

interface GitLaunch {
	/** Absolute Git executable frozen at startup; null when Git is absent. */
	executable: string | null;
	/** PATH frozen at startup, so a later PATH mutation cannot select a decoy git. */
	path: string;
	home: string | undefined;
}

function captureGitLaunch(): GitLaunch {
	const path = process.env.PATH ?? "";
	let executable: string | null = null;
	try {
		executable = Bun.which("git");
	} catch {
		executable = null;
	}
	return { executable, path, home: process.env.HOME };
}

/**
 * Startup snapshot, taken when this module loads — before any workspace code
 * runs. Probes reconstruct only these settings, so a later mutation of the
 * daemon environment cannot widen or redirect them.
 */
const GIT_LAUNCH: GitLaunch = captureGitLaunch();
const STARTUP_CREDENTIALS = captureGitCredentialSettings();

/**
 * Environment for a checkout-local read probe: the frozen launch with every
 * inherited Git control variable dropped and system/global config disabled,
 * so neither the daemon environment nor a mutable global-config path can
 * point the read at a decoy checkout.
 */
function localGitEnv(): Record<string, string> {
	return {
		PATH: GIT_LAUNCH.path,
		...(GIT_LAUNCH.home !== undefined ? { HOME: GIT_LAUNCH.home } : {}),
		GIT_TERMINAL_PROMPT: "0",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
	};
}

/**
 * Environment for the temporary probe repository: the captured credentials
 * plus a private HOME, with system/global config disabled so the probe honors
 * no includes, url rewrites, or hooks from the daemon or the workspace.
 */
function probeGitEnv(credentials: GitCredentialSettings, homeDir: string): Record<string, string> {
	return {
		...credentials.env,
		PATH: GIT_LAUNCH.path,
		HOME: homeDir,
		GIT_TERMINAL_PROMPT: "0",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
	};
}

async function runGit(
	args: string[],
	cwd: string,
	env: Record<string, string>,
): Promise<GitResult> {
	const executable = GIT_LAUNCH.executable;
	if (executable === null) {
		return { exitCode: -1, stdout: "", stderr: "git executable not found on the daemon PATH" };
	}
	try {
		const proc = Bun.spawn([executable, "-C", cwd, ...args], {
			stdout: "pipe",
			stderr: "pipe",
			env,
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
	env: Record<string, string>,
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
 * tip is preserved by an advertised remote ref. Fails closed (ok:false) on
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
		const env = probeGitEnv(input.credentials, probeDir);
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
		const isCommitPreserved = async (commit: string): Promise<boolean> => {
			if (remoteTips.includes(commit)) return true;
			for (const remoteTip of remoteTips) {
				if (await isAncestor(commit, remoteTip)) return true;
			}
			return false;
		};
		/**
		 * Only commit refs may be proven by ancestry: their only content is the
		 * commit graph. An annotated tag's direct object (name, tagger metadata,
		 * message, signature) is NOT preserved by its peeled target being
		 * reachable — deleting the checkout would lose the tag object — so the
		 * exact object must be advertised by the source remote.
		 */
		const isRefPreserved = async (ref: ListedRef): Promise<boolean> => {
			if (ref.type !== "commit") return remoteObjects.has(ref.object);
			return isCommitPreserved(ref.tip);
		};

		const refs: Array<{ name: string; tip: string; preserved: boolean }> = [];
		for (const ref of input.localRefs) {
			refs.push({ name: ref.name, tip: ref.tip, preserved: await isRefPreserved(ref) });
		}
		if (input.branch === null) {
			refs.push({
				name: "HEAD",
				tip: input.head,
				preserved: await isCommitPreserved(input.head),
			});
		}
		if (input.pinnedRevision !== undefined) {
			if (!(await isCommitPreserved(input.pinnedRevision))) {
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
		const env = localGitEnv();
		const headRes = await runGit(["rev-parse", "--verify", "HEAD^{commit}"], checkoutDir, env);
		if (headRes.exitCode !== 0) {
			return unknown(`cannot resolve HEAD: ${gitError(headRes)}`);
		}
		const head = headRes.stdout.trim();
		const branchRes = await runGit(["symbolic-ref", "--short", "-q", "HEAD"], checkoutDir, env);
		const branch =
			branchRes.exitCode === 0 && branchRes.stdout.trim().length > 0
				? branchRes.stdout.trim()
				: null;
		if (options.branch !== undefined && branch !== null && branch !== options.branch) {
			return unknown(
				`checkout branch ${JSON.stringify(branch)} does not match the stored branch ${JSON.stringify(options.branch)}`,
			);
		}

		const statusRes = await runGit(["status", "--porcelain=v1"], checkoutDir, env);
		if (statusRes.exitCode !== 0) {
			return unknown(`git status failed: ${gitError(statusRes)}`);
		}
		const dirtyCounts = parsePorcelain(statusRes.stdout);

		// A failed stash probe is not "zero stashes": it blocks as unknown.
		const stashRes = await runGit(["stash", "list"], checkoutDir, env);
		if (stashRes.exitCode !== 0) {
			return unknown(`git stash list failed: ${gitError(stashRes)}`);
		}
		const stashes = stashRes.stdout
			.trim()
			.split("\n")
			.filter((line) => line.length > 0).length;

		const refsRes = await listRefs(checkoutDir, ["refs/heads", "refs/tags"], env);
		if (!refsRes.ok) return unknown(`cannot list local refs: ${refsRes.error}`);
		const localRefs = refsRes.refs;

		// RAW origin with includes disabled: a repo-local include.path (or a
		// url.<base>.insteadOf rewrite) can never masquerade as the stored
		// source the fleet pinned. Checked BEFORE any network access.
		const originRes = await runGit(
			["config", "--local", "--no-includes", "--get", "remote.origin.url"],
			checkoutDir,
			env,
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
			const remoteList = await runGit(["remote", "-v"], checkoutDir, env);
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
