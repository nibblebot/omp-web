/**
 * LLM-assisted changelog summarizer for the release machinery (release-plan.md
 * section 3). Deterministic structure, LLM prose: the caller groups commits
 * by class; this module runs one prompt per bounded chunk of commits, plus a
 * final bounded turn for the release overview, and returns a ChangelogDraft.
 *
 * Contracts:
 * - NEVER throws — every failure path (missing omp binary, non-zero exit,
 *   timeout, malformed output) returns null so the caller can fall back to
 *   the deterministic changelog. A chunk whose output fails to parse is
 *   skipped (the caller's per-group coverage validation then falls back for
 *   that group); a chunk timeout aborts the whole LLM path (a stuck model
 *   would only keep timing out).
 * - Each turn is a one-shot `omp -p --no-pty --no-session [--profile <p>]`
 *   subprocess call with the prompt as its argument; stdout is the assistant
 *   text. The binary resolves via `Bun.which("omp")`. No session daemon, no
 *   auth storage, no model registry.
 * - Chunking exists because a single turn cannot reliably emit one polished
 *   bullet per commit for hundreds of commits (long structured JSON output
 *   degrades or times out); per-commit latency is ~7s on the default model,
 *   so chunk size is bounded.
 */

export type CommitClass = "breaking" | "feat" | "fix" | "other";

export interface ChangelogDraft {
	overview: string | null;
	groups: { cls: CommitClass; bullets: string[] }[];
}

export interface SummarizeInput {
	version: string;
	groups: {
		cls: CommitClass;
		heading: string;
		commits: { hash: string; subject: string }[];
	}[];
}

/** The spawn seam shape: argv after the binary + prompt → stdout and exit code. */
export type SpawnFn = (
	args: string[],
	promptText: string,
) => Promise<{ stdout: string; code: number }>;

export interface SummarizeOptions {
	/**
	 * omp profile passed to every turn as `--profile <profile>`. The
	 * OMP_WEB_RELEASE_PROFILE env var falls back to this; it replaces the
	 * old agent-config-directory knob (a profile is the supported way to
	 * select a non-default agent configuration for a release run).
	 */
	profile?: string;
	/**
	 * Test seam: replaces the real `omp -p` subprocess entirely. Receives the
	 * argv (after the binary) and the prompt text; resolves the process
	 * stdout and exit code.
	 */
	spawn?: SpawnFn;
}

/** Static membership table for the four commit classes. */
const COMMIT_CLASSES: Record<string, true> = {
	breaking: true,
	feat: true,
	fix: true,
	other: true,
};
const DEFAULT_TIMEOUT_MS = 240_000;
const CHUNK_SIZE = 15;
const COMMIT_LINK_BASE = "https://github.com/nibblebot/omp-web/commit/";

interface TurnResult {
	text: string;
	/** true when omp timed out or was killed — the caller aborts rather than retrying. */
	timedOut: boolean;
}

const OMP_FLAGS = ["-p", "--no-pty", "--no-session"];

/**
 * Summarize the grouped commits into a ChangelogDraft. NEVER throws — any
 * failure (missing omp binary, non-zero exit, timeout, malformed output)
 * returns null so the caller can fall back to the deterministic changelog.
 */
export async function summarizeChangelog(
	input: SummarizeInput,
	opts?: SummarizeOptions,
): Promise<ChangelogDraft | null> {
	try {
		const profile = opts?.profile ?? process.env.OMP_WEB_RELEASE_PROFILE;
		const startedAt = Date.now();
		const drafts: { cls: CommitClass; bullets: string[] }[] = [];
		for (const group of input.groups) {
			for (let i = 0; i < group.commits.length; i += CHUNK_SIZE) {
				const chunk = group.commits.slice(i, i + CHUNK_SIZE);
				const promptText = buildGroupPrompt(input.version, group.cls, group.heading, chunk);
				const elapsedMin = ((Date.now() - startedAt) / 60_000).toFixed(1);
				console.log(
					`release-llm: turn (${group.cls}, chunk ${i / CHUNK_SIZE + 1}/${Math.ceil(group.commits.length / CHUNK_SIZE)}, ${chunk.length} commits) — ${elapsedMin} min elapsed`,
				);
				const text = await runTurn(promptText, profile, DEFAULT_TIMEOUT_MS, opts?.spawn);
				if (text === null) return null; // timeout/error: a stuck model stays stuck
				const parsed = parseGroupDraft(text);
				if (parsed === null) continue; // malformed output: skip chunk, caller falls back per group
				drafts.push(parsed);
			}
		}
		if (drafts.length === 0) return null;
		// Merge chunk drafts per class: the caller matches draft groups by
		// cls (validateCoverage), so one class must be one entry.
		const merged = new Map<CommitClass, string[]>();
		for (const draft of drafts) {
			const existing = merged.get(draft.cls) ?? [];
			existing.push(...draft.bullets);
			merged.set(draft.cls, existing);
		}
		const draftGroups: { cls: CommitClass; bullets: string[] }[] = [...merged.entries()].map(
			([cls, bullets]) => ({ cls, bullets }),
		);
		console.log(
			`release-llm: turn (overview) — ${((Date.now() - startedAt) / 60_000).toFixed(1)} min elapsed`,
		);
		const overviewText = await runTurn(
			buildOverviewPrompt(input.version, draftGroups),
			profile,
			DEFAULT_TIMEOUT_MS,
			opts?.spawn,
		);
		const overview = overviewText === null ? null : parseOverview(overviewText);
		return { overview, groups: draftGroups };
	} catch {
		return null;
	}
}

/**
 * One turn: spawn `omp -p` with the prompt and race it against the timeout.
 * Resolves the trimmed stdout, or null on timeout/non-zero exit/empty output.
 * Exported for tests: the timeout case needs a short timeout budget, while
 * summarizeChangelog always uses DEFAULT_TIMEOUT_MS.
 */
export async function runTurn(
	promptText: string,
	profile: string | undefined,
	timeoutMs: number,
	spawn?: SpawnFn,
): Promise<string | null> {
	const args = [...OMP_FLAGS];
	if (profile !== undefined) args.push("--profile", profile);
	const run: Promise<TurnResult> =
		spawn !== undefined
			? spawn(args, promptText).then(({ stdout, code }) =>
					code !== 0 ? { text: "", timedOut: false } : { text: stdout, timedOut: false },
				)
			: spawnOmp(args, promptText);
	const result = await withTimeout(run, timeoutMs);
	if (!result.ok) return null;
	if (result.value.timedOut) return null;
	const text = result.value.text.trim();
	return text.length === 0 ? null : text;
}

const spawnOmp = (args: string[], promptText: string): Promise<TurnResult> => {
	const { promise, resolve, reject } = Promise.withResolvers<TurnResult>();
	const bin = Bun.which("omp") ?? "omp";
	const proc = Bun.spawn([bin, ...args, promptText], { stdout: "pipe", stderr: "pipe" });
	// Both `exited` and the stdout text resolve the promise; the LAST of the
	// two wins. The guards below are intentionally absent: `exited` fires
	// before the process is reaped (proc.exitCode is still null then) and the
	// stdout text resolves after reaping (exitCode is set), so each branch
	// must resolve unconditionally or the turn deadlocks until the timeout.
	proc.exited.then(
		(code) => {
			resolve({ text: "", timedOut: false });
		},
		(reason) => reject(reason instanceof Error ? reason : new Error(String(reason))),
	);
	new Response(proc.stdout).text().then(
		(text) => {
			resolve({ text, timedOut: false });
		},
		(reason) => reject(reason instanceof Error ? reason : new Error(String(reason))),
	);
	return promise;
};

type Settled<T> = { ok: true; value: T } | { ok: false };

/** Race a promise against a timeout without ever leaving a rejection unhandled. */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<Settled<T>> {
	const { promise: settled, resolve } = Promise.withResolvers<Settled<T>>();
	const timer = setTimeout(() => resolve({ ok: false }), timeoutMs);
	promise.then(
		(value) => {
			clearTimeout(timer);
			resolve({ ok: true, value });
		},
		() => {
			clearTimeout(timer);
			resolve({ ok: false });
		},
	);
	return settled;
}

/**
 * Deterministic prompt for one chunk of one group: fixed instruction block
 * (version embedded), the chunk's commits as `### <heading>` +
 * `- <hash> <subject>`, then the strict single-JSON-object output contract.
 */
function buildGroupPrompt(
	version: string,
	cls: CommitClass,
	heading: string,
	commits: { hash: string; subject: string }[],
): string {
	const lines: string[] = [
		`You are writing the changelog for omp-web ${version}.`,
		"Rewrite each commit below as a polished, user-facing release-note bullet:",
		"- One bullet per commit, ending with that commit's hash link.",
		"- Imperative voice, at most 20 words per bullet, plain prose.",
		"- Keep every commit; never invent or drop commits.",
		"",
		"Commits to summarize:",
		`### ${heading}`,
	];
	for (const commit of commits) lines.push(`- ${commit.hash} ${commit.subject}`);
	lines.push(
		"",
		"Output ONLY a single JSON object — no prose, no markdown, no code fences — in this shape:",
		`{ "cls": "${cls}", "bullets": ["<bullet> ([<hash>](${COMMIT_LINK_BASE}<hash>))"] }`,
		"- Every bullet must end with its commit hash link " + `([<hash>](${COMMIT_LINK_BASE}<hash>)).`,
		`- "cls" must be exactly "${cls}".`,
	);
	return lines.join("\n");
}

/**
 * Deterministic prompt for the release overview: the polished per-group
 * bullet lists (bounded to the first two bullets per group to keep the turn
 * cheap), asking for a 1-3 sentence summary.
 */
function buildOverviewPrompt(
	version: string,
	drafts: { cls: CommitClass; bullets: string[] }[],
): string {
	const lines: string[] = [
		`You are writing the release summary for omp-web ${version}.`,
		"Here are the changelog sections (first bullets shown):",
	];
	for (const draft of drafts) {
		lines.push(`### ${draft.cls} (${draft.bullets.length} changes)`);
		for (const bullet of draft.bullets.slice(0, 2)) lines.push(`- ${bullet}`);
	}
	lines.push(
		"",
		"Write a 1-3 sentence user-facing overview of this release. " +
			"Never invent details not present above.",
		"Output ONLY a single JSON object — no prose, no markdown — in this shape:",
		'{ "overview": "<1-3 sentence release summary>" }',
		'"overview" may be an empty string only if you cannot summarize.',
	);
	return lines.join("\n");
}

/** Parse and shape-validate one chunk's JSON output; null on any mismatch. */
function parseGroupDraft(text: string): { cls: CommitClass; bullets: string[] } | null {
	const body = extractJsonObject(text);
	if (body === null) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return null;
	}
	if (!isObject(parsed) || Array.isArray(parsed)) return null;
	// JSON.parse output — shape-validated field by field below.
	const obj = parsed as Record<string, unknown>;
	if (typeof obj.cls !== "string" || COMMIT_CLASSES[obj.cls] !== true) return null;
	if (!Array.isArray(obj.bullets) || !obj.bullets.every((b) => typeof b === "string")) return null;
	return { cls: obj.cls as CommitClass, bullets: obj.bullets as string[] };
}

/** Parse and shape-validate the overview JSON output; null on any mismatch. */
function parseOverview(text: string): string | null {
	const body = extractJsonObject(text);
	if (body === null) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return null;
	}
	if (!isObject(parsed) || Array.isArray(parsed)) return null;
	// JSON.parse output — shape-validated field by field below.
	const obj = parsed as Record<string, unknown>;
	if (typeof obj.overview !== "string") return null;
	// An empty overview means "could not summarize" → omit the paragraph.
	return obj.overview.trim() === "" ? null : obj.overview;
}

/**
 * Extract the JSON object from the model output: tolerate ```json fences and
 * stray prose by taking the first `{` through the last `}`.
 */
function extractJsonObject(text: string): string | null {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start === -1 || end === -1 || end <= start) return null;
	return text.slice(start, end + 1);
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
