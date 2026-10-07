// G02: narrow daemon-bound repository adapter over the native VCS layer.
//
// Boundaries:
// - Reuses nonvisual `GitModel` porcelain semantics (staged/unstaged split,
//   rename/conflict mapping) but never constructs the TUI model: this adapter
//   binds to the daemon cwd, owns one cached snapshot, and gates every
//   mutation on a caller-supplied fingerprint (drift/index-lock/external
//   change -> typed stale refusal, never a stale stage or hidden commit).
// - Hunk staging goes through the bounded native `stageHunks` patch adapter
//   (validate-then-stage against the live unstaged diff); there is no
//   hand-rolled patch application here.
// - `GitModel.stage/unstage(files?)` treat an omitted selection as "everything":
//   this adapter rejects empty-paths-without-explicit-all instead.
// - No auto stage-all/commit/amend/reset/fetch/push. Commit never stages.
// - Never runs arbitrary user shell strings: all mutations are argv-free
//   native VCS calls (stageFiles/unstage/stageHunks/commitCreate).
// - Secrets/tokens never appear in DTOs/logs. stdout stays reserved for
//   OMP_SESSION| lines (errors go to the caller, never console.log).

import { git, isVcsError, validateHunkSelections } from "@oh-my-pi/pi-natives/vcs";
import type { VcsGitRepo, VcsNumstatEntry } from "@oh-my-pi/pi-natives";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { parseReviewDiffSnapshot } from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/bundled/review/diff";
import type { GitPathEntry, GitStatusDto } from "#lib/wire/protocol";
import type { SessionEntry } from "./session-entry";
export type ChangeKind = GitPathEntry["kind"];

/** One changed path, mirroring GitModel's ChangedFile vocabulary. */
export interface RepoChangedFile extends GitPathEntry {
	area: "unstaged" | "staged";
}

export interface RepoHead {
	sha: string;
	shortSha: string;
	subject: string;
	authorName: string;
	authorEmail: string;
	authorDate: string;
}

export interface RepoSnapshot {
	available: boolean;
	reason?: string;
	cwd: string;
	branch: string | null;
	clean: boolean;
	indexFingerprint: string;
	worktreeFingerprint: string;
	unstaged: RepoChangedFile[];
	staged: RepoChangedFile[];
	head: RepoHead | null;
}

/** Typed refusal: the caller must refresh and retry deliberately. */
export class RepoStaleError extends Error {
	readonly code = "stale" as const;
	readonly expectedFingerprint: string;
	readonly actualFingerprint: string;
	constructor(expected: string, actual: string) {
		super(
			`repository changed since this view was taken (expected fingerprint ${expected.slice(0, 12)}, now ${actual.slice(0, 12)}); refresh and retry`,
		);
		this.name = "RepoStaleError";
		this.expectedFingerprint = expected;
		this.actualFingerprint = actual;
	}
}

/** Typed refusal: the repository cannot be staged/committed in this state. */
export class RepoNotEligibleError extends Error {
	readonly code = "not_eligible" as const;
	constructor(reason: string) {
		super(reason);
		this.name = "RepoNotEligibleError";
	}
}

const CONFLICT_STATES: Record<string, true> = {
	DD: true,
	AU: true,
	UD: true,
	UA: true,
	DU: true,
	AA: true,
	UU: true,
};

function kindFromLetter(letter: string): ChangeKind {
	switch (letter) {
		case "A":
			return "added";
		case "D":
			return "deleted";
		case "R":
		case "C":
			return "renamed";
		case "U":
			return "conflicted";
		default:
			return "modified";
	}
}

/** Parse `git status --porcelain=v1 -z` into staged/unstaged lists (GitModel parity). */
export function parsePorcelain(statusText: string): {
	unstaged: RepoChangedFile[];
	staged: RepoChangedFile[];
} {
	const unstaged: RepoChangedFile[] = [];
	const staged: RepoChangedFile[] = [];
	const tokens = statusText.split("\0");
	for (let i = 0; i < tokens.length; i++) {
		const record = tokens[i];
		if (record.length < 4) continue;
		const x = record[0];
		const y = record[1];
		const filePath = record.slice(3);
		// In `-z` output a rename/copy record is followed by the original
		// path as its own NUL-separated token.
		const origPath = x === "R" || x === "C" || y === "R" || y === "C" ? tokens[++i] : undefined;
		if (x === "?" && y === "?") {
			unstaged.push({ path: filePath, kind: "untracked", area: "unstaged" });
			continue;
		}
		if (CONFLICT_STATES[`${x}${y}`]) {
			unstaged.push({ path: filePath, kind: "conflicted", area: "unstaged" });
			continue;
		}
		if (x !== " ")
			staged.push({ path: filePath, origPath, kind: kindFromLetter(x), area: "staged" });
		if (y !== " ")
			unstaged.push({ path: filePath, origPath, kind: kindFromLetter(y), area: "unstaged" });
	}
	return { unstaged, staged };
}

export interface RepoAdapterOptions {
	cwd: string;
	/** Resolve the bound repo. Defaults to native `git(cwd)` discovery. */
	openRepo?: (cwd: string) => VcsGitRepo | null;
}

function vcsMessage(error: unknown): string {
	if (isVcsError(error)) {
		const detail = error.stderr.trim() || error.message;
		return detail.slice(0, 500);
	}
	return error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
}

/** Never follow a repository symlink when reading worktree bytes. */
async function worktreeBytes(
	root: string,
	path: string,
	consume: (chunk: Uint8Array) => void,
	maxBytes = Number.MAX_SAFE_INTEGER,
): Promise<boolean> {
	const jail = await realpath(root);
	const target = resolve(jail, path);
	const inside = relative(jail, target);
	if (isAbsolute(inside) || inside === ".." || inside.startsWith(`..${sep}`))
		throw new RepoNotEligibleError("refusing worktree path outside repository");
	let parent = jail;
	for (const segment of relative(jail, dirname(target)).split(sep).filter(Boolean)) {
		parent = resolve(parent, segment);
		if ((await lstat(parent)).isSymbolicLink())
			throw new RepoNotEligibleError("refusing worktree path through a symlink");
	}
	const stat = await lstat(target);
	if (stat.isSymbolicLink()) {
		const bytes = Buffer.from(await readlink(target));
		consume(bytes.subarray(0, maxBytes));
		return bytes.byteLength > maxBytes;
	}
	if (!stat.isFile()) throw new RepoNotEligibleError("review requires a regular file or symlink");
	const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const buffer = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1));
		let total = 0;
		for (;;) {
			const { bytesRead } = await file.read(
				buffer,
				0,
				Math.min(buffer.length, maxBytes + 1 - total),
				null,
			);
			if (!bytesRead) return false;
			const remaining = maxBytes - total;
			consume(buffer.subarray(0, Math.min(bytesRead, remaining)));
			total += bytesRead;
			if (total > maxBytes) return true;
		}
	} finally {
		await file.close();
	}
}

/**
 * Narrow daemon-bound repository adapter. One instance per daemon cwd;
 * snapshot state is cached only to detect drift (callers always re-read
 * before mutating). All methods throw plain Errors naming at most the cwd
 * tail and git's own stderr (never tokens, never absolute host paths beyond
 * the bound cwd).
 */
export class RepoAdapter {
	private readonly cwd: string;
	private readonly openRepo: (cwd: string) => VcsGitRepo | null;

	constructor(options: RepoAdapterOptions) {
		this.cwd = options.cwd;
		this.openRepo = options.openRepo ?? ((dir) => git(dir));
	}

	private repo(): VcsGitRepo {
		const repo = this.openRepo(this.cwd);
		if (!repo) throw new RepoNotEligibleError(`not a git repository: ${this.cwd}`);
		return repo;
	}

	private async headOf(repo: VcsGitRepo): Promise<RepoHead | null> {
		const sha = await repo.headSha(null).catch(() => null);
		if (!sha) return null;
		try {
			const details = await repo.commitDetails(sha, null);
			const [subject = "", ..._body] = details.message.split("\n");
			return {
				sha,
				shortSha: sha.slice(0, 8),
				subject,
				authorName: details.author.name,
				authorEmail: details.author.email,
				authorDate: details.author.date ?? "",
			};
		} catch {
			return null;
		}
	}

	/** Re-read fast repository state (porcelain + branch + head). */
	async snapshot(): Promise<RepoSnapshot> {
		let repo: VcsGitRepo;
		try {
			repo = this.repo();
		} catch (error) {
			return {
				available: false,
				reason: error instanceof Error ? error.message : String(error),
				cwd: this.cwd,
				branch: null,
				clean: true,
				indexFingerprint: "",
				worktreeFingerprint: "",
				unstaged: [],
				staged: [],
				head: null,
			};
		}
		let statusText: string;
		try {
			statusText = await repo.statusPorcelain({ nulTerminated: true, untracked: "all" }, null);
		} catch (error) {
			return {
				available: false,
				reason: `git status failed: ${vcsMessage(error)}`,
				cwd: this.cwd,
				branch: null,
				clean: true,
				indexFingerprint: "",
				worktreeFingerprint: "",
				unstaged: [],
				staged: [],
				head: null,
			};
		}
		const [branch, head] = await Promise.all([
			repo.currentBranch(null).catch(() => null),
			this.headOf(repo),
		]);
		const { unstaged, staged: stagedFiles } = parsePorcelain(statusText);
		// Numstats populate lazily (staged + unstaged); a failure degrades to
		// count-less entries rather than failing the whole snapshot.
		try {
			const [unstagedStat, stagedStat] = await Promise.all([
				repo.numstat({}, null),
				repo.numstat({ cached: true }, null),
			]);
			const unstagedCounts = new Map<string, VcsNumstatEntry>(unstagedStat.map((e) => [e.path, e]));
			const stagedCounts = new Map<string, VcsNumstatEntry>(stagedStat.map((e) => [e.path, e]));
			for (const f of unstaged) {
				const c = unstagedCounts.get(f.path);
				if (c) {
					f.additions = c.added ?? 0;
					f.deletions = c.removed ?? 0;
				}
			}
			for (const f of stagedFiles) {
				const c = stagedCounts.get(f.path);
				if (c) {
					f.additions = c.added ?? 0;
					f.deletions = c.removed ?? 0;
				}
			}
		} catch {
			// Counts are advisory; the file lists above stay authoritative.
		}
		const [indexPatch, worktreePatch] = await Promise.all([
			repo.diffText({ cached: true, binary: true }, null),
			repo.diffText({ binary: true }, null),
		]);
		const hash = createHash("sha256");
		for (const part of [head?.sha ?? "", statusText, indexPatch, worktreePatch]) {
			hash
				.update(String(Buffer.byteLength(part)))
				.update("\0")
				.update(part);
		}
		for (const entry of unstaged.filter((file) => file.kind === "untracked")) {
			RepoAdapter.checkPath(entry.path);
			hash.update("\0untracked\0").update(entry.path).update("\0");
			await worktreeBytes(repo.info().repoRoot, entry.path, (chunk) => {
				hash.update(chunk);
			});
			hash.update("\0end\0");
		}
		const fingerprint = hash.digest("hex");
		return {
			available: true,
			cwd: this.cwd,
			branch: branch ?? null,
			clean: unstaged.length === 0 && stagedFiles.length === 0,
			indexFingerprint: fingerprint,
			worktreeFingerprint: fingerprint,
			unstaged,
			staged: stagedFiles,
			head,
		};
	}

	/**
	 * Re-read and require the index/worktree to still match `fingerprint`.
	 * Returns the fresh snapshot on match; throws RepoStaleError otherwise.
	 */
	async requireFresh(fingerprint: string): Promise<RepoSnapshot> {
		const snap = await this.snapshot();
		if (!snap.available) {
			throw new RepoNotEligibleError(snap.reason ?? "repository unavailable");
		}
		if (snap.indexFingerprint !== fingerprint) {
			throw new RepoStaleError(fingerprint, snap.indexFingerprint);
		}
		return snap;
	}

	/**
	 * Guard one path against directory escape: absolute paths, `..`
	 * segments, and NUL bytes never reach the native layer.
	 */
	private static checkPath(path: string): void {
		if (!path || path.includes("\0"))
			throw new Error(`refusing unsafe path: ${JSON.stringify(path)}`);
		const segments = path.split("/");
		if (isAbsolute(path) || path.includes("\\") || segments.includes("..")) {
			throw new Error(`refusing path outside the repository: ${JSON.stringify(path)}`);
		}
	}

	/**
	 * Resolve caller-selected paths against the fresh snapshot: unknown
	 * paths and conflicted entries are rejected (conflicts need explicit
	 * resolution first, never silent staging).
	 */
	private static resolveSelection(
		snap: RepoSnapshot,
		area: "unstaged" | "staged",
		paths: readonly string[],
	): string[] {
		const list = area === "unstaged" ? snap.unstaged : snap.staged;
		const known = new Map(list.map((f) => [f.path, f]));
		const resolved: string[] = [];
		for (const p of paths) {
			RepoAdapter.checkPath(p);
			const entry = known.get(p);
			if (!entry) throw new Error(`no ${area} change at path: ${p}`);
			if (entry.kind === "conflicted") {
				throw new RepoNotEligibleError(`resolve conflicts before staging: ${p}`);
			}
			resolved.push(p);
			if (entry.origPath) {
				RepoAdapter.checkPath(entry.origPath);
				resolved.push(entry.origPath);
			}
		}
		return [...new Set(resolved)];
	}

	/**
	 * Stage caller-selected unstaged paths. Empty `paths` without explicit
	 * `all: true` is rejected (GitModel's stage-everything default is the
	 * accidental-selection footgun G02.2 forbids).
	 */
	async stageSelected(
		paths: readonly string[],
		fingerprint: string,
		all = false,
	): Promise<RepoSnapshot> {
		if (paths.length === 0 && !all) {
			throw new Error("refusing to stage everything: pass explicit paths or confirm stage-all");
		}
		const snap = await this.requireFresh(fingerprint);
		const repo = this.repo();
		try {
			const selected = RepoAdapter.resolveSelection(
				snap,
				"unstaged",
				paths.length === 0 ? snap.unstaged.map((file) => file.path) : paths,
			);
			if (selected.length > 0) await repo.stageFiles(selected, null);
		} catch (error) {
			if (error instanceof RepoStaleError || error instanceof RepoNotEligibleError) throw error;
			throw new Error(`git stage failed: ${vcsMessage(error)}`);
		}
		return this.snapshot();
	}

	/** Unstage caller-selected staged paths (same empty-selection guard). */
	async unstageSelected(
		paths: readonly string[],
		fingerprint: string,
		all = false,
	): Promise<RepoSnapshot> {
		if (paths.length === 0 && !all) {
			throw new Error("refusing to unstage everything: pass explicit paths or confirm unstage-all");
		}
		const snap = await this.requireFresh(fingerprint);
		const repo = this.repo();
		try {
			const selected = RepoAdapter.resolveSelection(
				snap,
				"staged",
				paths.length === 0 ? snap.staged.map((file) => file.path) : paths,
			);
			if (selected.length > 0) await repo.unstage(selected, null);
		} catch (error) {
			if (error instanceof RepoStaleError || error instanceof RepoNotEligibleError) throw error;
			throw new Error(`git unstage failed: ${vcsMessage(error)}`);
		}
		return this.snapshot();
	}

	/**
	 * Stage caller-selected hunks through the bounded native patch adapter:
	 * selections validate against the LIVE unstaged diff first, then apply
	 * to the index only. `hunkIndices` are 1-based per-file hunk indices
	 * (VcsHunkSelection vocabulary); the raw diff is always re-read, never
	 * caller-supplied.
	 */
	async stageHunks(
		path: string,
		hunkIndices: readonly number[],
		fingerprint: string,
	): Promise<RepoSnapshot> {
		RepoAdapter.checkPath(path);
		if (hunkIndices.length === 0) throw new Error("refusing to stage with no hunks selected");
		const snap = await this.requireFresh(fingerprint);
		const entry = snap.unstaged.find((f) => f.path === path);
		if (!entry) throw new Error(`no unstaged change at path: ${path}`);
		if (entry.kind === "conflicted" || entry.kind === "untracked") {
			throw new RepoNotEligibleError(
				entry.kind === "conflicted"
					? `resolve conflicts before staging hunks: ${path}`
					: `stage untracked files whole, not by hunk: ${path}`,
			);
		}
		const repo = this.repo();
		let rawDiff: string;
		try {
			rawDiff = await repo.diffText({ files: [path] }, null);
		} catch (error) {
			throw new Error(`git diff failed: ${vcsMessage(error)}`);
		}
		const selections = [{ path, kind: "indices", indices: [...hunkIndices] }];
		const problems = validateHunkSelections(rawDiff, selections);
		if (problems.length > 0) {
			throw new Error(
				`hunk selection invalid: ${problems
					.map((p) => p.message)
					.join("; ")
					.slice(0, 300)}`,
			);
		}
		try {
			await repo.stageHunks(selections, rawDiff, null);
		} catch (error) {
			throw new Error(`git stage-hunks failed: ${vcsMessage(error)}`);
		}
		return this.snapshot();
	}

	/**
	 * Create a commit from the CURRENT index only. Never stages, never
	 * amends, never pushes. An empty message or empty index is refused.
	 * Hook/signing/git failures propagate WITHOUT discarding the caller's
	 * message (the caller owns the draft; retry after fixing the hook).
	 */
	async commitSelected(message: string, fingerprint: string): Promise<{ sha: string }> {
		const trimmed = message.trim();
		if (!trimmed) throw new Error("refusing to commit with an empty message");
		const snap = await this.requireFresh(fingerprint);
		if (snap.staged.length === 0)
			throw new Error("refusing to commit with an empty index: stage first");
		const repo = this.repo();
		try {
			const sha = await repo.commitCreate(trimmed, {}, null);
			return { sha };
		} catch (error) {
			// The message stays with the caller (it was passed in, never
			// consumed); surface git's own failure verbatim.
			throw new Error(`git commit failed (message preserved): ${vcsMessage(error)}`);
		}
	}

	/**
	 * Render one file's old/new text for review. Binary/oversize sides are
	 * reported, never inlined: `{ binary: true }` / `{ tooLarge: true }`.
	 * `area: "commit"` compares the file at HEAD^ vs HEAD.
	 */
	async fileDiff(
		path: string,
		area: "unstaged" | "staged" | "commit",
		maxBytes = 256 * 1024,
	): Promise<{
		oldText?: string;
		newText?: string;
		binary: boolean;
		tooLarge: boolean;
		fingerprint: string;
		hunks: { index: number; header: string; text: string }[];
		truncated: boolean;
	}> {
		RepoAdapter.checkPath(path);
		const snap = await this.snapshot();
		if (!snap.available) throw new RepoNotEligibleError(snap.reason ?? "repository unavailable");
		const repo = this.repo();
		if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 * 1024)
			throw new Error("file diff byte limit must be between 1 and 1048576");
		try {
			const entry = (area === "staged" ? snap.staged : snap.unstaged).find(
				(file) => file.path === path,
			);
			let base: string | undefined;
			let head: string | undefined;
			if (area === "commit") {
				head = snap.head?.sha;
				if (!head) throw new RepoNotEligibleError("no HEAD commit to compare against");
				base = (await repo.commitDetails(head, null)).parents[0];
			}
			let patch = "";
			let truncated = false;
			try {
				patch =
					area === "commit" && !base
						? ""
						: await repo.diffText(
								{
									cached: area === "staged",
									base,
									head,
									files: entry?.origPath ? [path, entry.origPath] : [path],
									maxBytes,
									binary: false,
								},
								null,
							);
			} catch (error) {
				if (!isVcsError(error) || error.code !== "OutputTooLarge") throw error;
				truncated = true;
			}
			const parsed = parseReviewDiffSnapshot(patch).files.find((file) => file.path === path);
			const oldPath = parsed?.oldPath ?? entry?.origPath ?? path;
			RepoAdapter.checkPath(oldPath);
			const blob = async (rev: string | undefined, filePath: string, index = false) => {
				if (!rev) return null;
				const paths = index
					? await repo.lsFiles(false, false, null)
					: await repo.lsTree(rev, [filePath], null);
				if (!paths.includes(filePath)) return null;
				return repo.showBlob(index ? `:0:${filePath}` : `${rev}:${filePath}`, maxBytes, null);
			};
			const oldSide =
				area === "unstaged"
					? await blob("index", oldPath, true)
					: await blob(area === "staged" ? snap.head?.sha : base, oldPath);
			let newSide: { data: Buffer; truncated: boolean } | null;
			if (area === "unstaged") {
				if (entry?.kind === "deleted") newSide = null;
				else {
					const chunks: Buffer[] = [];
					const oversized = await worktreeBytes(
						repo.info().repoRoot,
						path,
						(chunk) => chunks.push(Buffer.from(chunk)),
						maxBytes,
					);
					newSide = { data: Buffer.concat(chunks), truncated: oversized };
				}
			} else newSide = await blob(area === "staged" ? "index" : head, path, area === "staged");
			const sides = [oldSide, newSide];
			const binary =
				sides.some((side) => side !== null && Buffer.from(side.data).includes(0)) ||
				parsed?.isBinary === true;
			const tooLarge = sides.some((side) => side?.truncated === true);
			const hunks: { index: number; header: string; text: string }[] = [];
			if (area === "unstaged" && !binary && !tooLarge && !truncated) {
				for (const line of (parsed?.rawDiff ?? "").split("\n")) {
					if (line.startsWith("@@ "))
						hunks.push({ index: hunks.length + 1, header: line, text: line });
					else if (hunks.length) hunks[hunks.length - 1].text += `\n${line}`;
				}
			}
			const decode = (side: typeof oldSide) =>
				side && !binary && !tooLarge
					? new TextDecoder("utf-8").decode(Buffer.from(side.data))
					: undefined;
			return {
				oldText: decode(oldSide),
				newText: decode(newSide),
				binary,
				tooLarge,
				fingerprint: snap.indexFingerprint,
				hunks,
				truncated,
			};
		} catch (error) {
			if (error instanceof RepoStaleError || error instanceof RepoNotEligibleError) throw error;
			throw new Error(`git diff failed: ${vcsMessage(error)}`);
		}
	}

	/** Raw unstaged patch for hunk validation / revision compare (bounded). */
	async unstagedPatch(maxBytes = 1024 * 1024): Promise<{ patch: string; truncated: boolean }> {
		const repo = this.repo();
		const patch = await repo.diffText({}, null).catch((error: unknown) => {
			throw new Error(`git diff failed: ${vcsMessage(error)}`);
		});
		if (patch.length > maxBytes) return { patch: patch.slice(0, maxBytes), truncated: true };
		return { patch, truncated: false };
	}

	toDto(snap: RepoSnapshot): GitStatusDto {
		return {
			available: snap.available,
			reason: snap.reason,
			cwd: snap.cwd,
			branch: snap.branch,
			clean: snap.clean,
			indexFingerprint: snap.indexFingerprint,
			worktreeFingerprint: snap.worktreeFingerprint,
			eligible: {
				stage: snap.available && !snap.clean,
				commit: snap.available && snap.staged.length > 0,
				reason: !snap.available
					? (snap.reason ?? "repository unavailable")
					: snap.clean
						? "working tree clean"
						: snap.staged.length === 0
							? "index empty: stage first"
							: undefined,
			},
			unstaged: snap.unstaged,
			staged: snap.staged,
			head: snap.head,
		};
	}
}

type GitArgs = Record<string, unknown>;

function gitArgs(value: unknown): GitArgs {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Git arguments must be an object");
	return value as GitArgs;
}

/** Thin dispatch wrapper: entry cwd binds one RepoAdapter per call. */
export function createGitReviewMethods(): Record<
	string,
	(entry: SessionEntry, args: unknown[]) => Promise<unknown>
> {
	const adapter = (entry: SessionEntry): RepoAdapter => new RepoAdapter({ cwd: entry.cwd });
	return {
		gitStatus: async (entry) => adapter(entry).toDto(await adapter(entry).snapshot()),
		gitStage: async (entry, args) => {
			const input = gitArgs(args[0]);
			const paths = Array.isArray(input.paths)
				? input.paths.filter((p): p is string => typeof p === "string")
				: [];
			const fingerprint = String(input.fingerprint ?? "");
			return adapter(entry).toDto(
				await adapter(entry).stageSelected(paths, fingerprint, input.all === true),
			);
		},
		gitUnstage: async (entry, args) => {
			const input = gitArgs(args[0]);
			const paths = Array.isArray(input.paths)
				? input.paths.filter((p): p is string => typeof p === "string")
				: [];
			const fingerprint = String(input.fingerprint ?? "");
			return adapter(entry).toDto(
				await adapter(entry).unstageSelected(paths, fingerprint, input.all === true),
			);
		},
		gitStageHunks: async (entry, args) => {
			const input = gitArgs(args[0]);
			const indices = Array.isArray(input.hunkIndices)
				? input.hunkIndices.filter((n): n is number => Number.isInteger(n))
				: [];
			return adapter(entry).toDto(
				await adapter(entry).stageHunks(
					String(input.path ?? ""),
					indices,
					String(input.fingerprint ?? ""),
				),
			);
		},
		gitCommit: async (entry, args) => {
			const input = gitArgs(args[0]);
			const fingerprint =
				typeof input.fingerprint === "string" && input.fingerprint
					? input.fingerprint
					: (await adapter(entry).snapshot()).indexFingerprint;
			return adapter(entry).commitSelected(String(input.message ?? ""), fingerprint);
		},
		gitFileDiff: async (entry, args) => {
			const input = gitArgs(args[0]);
			const area = input.area === "staged" || input.area === "commit" ? input.area : "unstaged";
			return adapter(entry).fileDiff(String(input.path ?? ""), area);
		},
		gitUnstagedPatch: async (entry) => adapter(entry).unstagedPatch(),
	};
}
