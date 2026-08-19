/**
 * LLM-assisted changelog summarizer for the release machinery (release-plan.md
 * section 3). Deterministic structure, LLM prose: the caller groups commits
 * by class; this module runs one prompt per bounded chunk of commits, plus a
 * final bounded turn for the release overview, and returns a ChangelogDraft.
 *
 * Contracts:
 * - NEVER throws — every failure path (missing SDK/auth/model, timeout,
 *   prompt rejection, malformed output) returns null so the caller can fall
 *   back to the deterministic changelog. A chunk whose output fails to parse
 *   is skipped (the caller's per-group coverage validation then falls back
 *   for that group); a chunk timeout aborts the whole LLM path (a stuck
 *   model would only keep timing out).
 * - The SDK is imported LAZILY inside the bootstrap (mirrors
 *   fleet/omp-check.ts): this module's top level imports only node: builtins,
 *   so the deterministic path loads and its tests pass with no SDK present.
 * - Chunking exists because a single turn cannot reliably emit one polished
 *   bullet per commit for hundreds of commits (long structured JSON output
 *   degrades or times out); per-commit latency is ~7s on the default model,
 *   so chunk size is bounded.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

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

export interface SummarizeOptions {
	/** Override the omp agent config directory. */
	agentDir?: string;
	/** Per-turn wall-clock budget; default 240s (a chunk of ~15 commits runs ~2min). */
	timeoutMs?: number;
	/**
	 * Test seam: replaces the real SDK bootstrap entirely (no SDK import, no
	 * auth storage, no settings). Receives the bootstrap deps object and must
	 * return a `{ session: { prompt(text): Promise<unknown>; destroy?() } }`
	 * shaped object. `prompt` should resolve to the assistant text (a string)
	 * — the seam has no event subscription, so text is taken from the
	 * resolved value.
	 */
	sessionFactory?: (deps: unknown) => Promise<unknown>;
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

/** Minimal session surface the rest of this module drives. */
interface SessionLike {
	prompt(text: string): Promise<unknown>;
	destroy?(): void | Promise<void>;
	subscribe?(listener: (event: unknown) => void): () => void;
}

/**
 * The bootstrap deps object handed to a sessionFactory. With a factory the
 * SDK-owned instances are never built (the factory replaces the bootstrap
 * wholesale), so they arrive as null; cwd/agentDir are always resolved.
 */
interface BootstrapDeps {
	cwd: string;
	agentDir: string;
	authStorage: unknown;
	modelRegistry: unknown;
	settings: unknown;
	sessionManager: unknown;
	agentRegistry: unknown;
	eventBus: unknown;
}

/**
 * Summarize the grouped commits into a ChangelogDraft. NEVER throws — any
 * failure (missing SDK/auth/model, timeout, prompt rejection, malformed
 * output) returns null so the caller can fall back to the deterministic
 * changelog.
 */
export async function summarizeChangelog(
	input: SummarizeInput,
	opts?: SummarizeOptions,
): Promise<ChangelogDraft | null> {
	let cwd: string | null = null;
	try {
		cwd = mkdtempSync(join(tmpdir(), "omp-web-release-"));
		const agentDir = opts?.agentDir ?? process.env.OMP_WEB_RELEASE_AGENT_DIR ?? defaultAgentDir();
		const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		let session: SessionLike;
		if (opts?.sessionFactory) {
			const deps: BootstrapDeps = {
				cwd,
				agentDir,
				authStorage: null,
				modelRegistry: null,
				settings: null,
				sessionManager: null,
				agentRegistry: null,
				eventBus: null,
			};
			session = normalizeFactorySession(await opts.sessionFactory(deps));
		} else {
			session = await bootstrapSession(cwd, agentDir);
		}
		try {
			// One prompt per bounded chunk, one group at a time.
			const drafts: { cls: CommitClass; bullets: string[] }[] = [];
			for (const group of input.groups) {
				for (let i = 0; i < group.commits.length; i += CHUNK_SIZE) {
					const chunk = group.commits.slice(i, i + CHUNK_SIZE);
					const text = await runTurn(
						session,
						buildGroupPrompt(input.version, group.cls, group.heading, chunk),
						timeoutMs,
					);
					if (text === null) return null; // timeout: a stuck model stays stuck
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
			const overviewText = await runTurn(
				session,
				buildOverviewPrompt(input.version, draftGroups),
				timeoutMs,
			);
			const overview = overviewText === null ? null : parseOverview(overviewText);
			return { overview, groups: draftGroups };
		} finally {
			if (typeof session.destroy === "function") {
				try {
					await session.destroy();
				} catch {
					// Never-throw contract: teardown failures are not results.
				}
			}
		}
	} catch {
		return null;
	} finally {
		if (cwd !== null) rmSync(cwd, { recursive: true, force: true });
	}
}

/**
 * Default omp agent config directory, mirroring the omp-session daemon's
 * `getAgentDir()` from @oh-my-pi/pi-utils (~/.omp/agent, honoring
 * PI_CODING_AGENT_DIR with tilde expansion). Profile and XDG redirects are a
 * deliberate no-op here — a release tool runs in the default configuration,
 * and OMP_WEB_RELEASE_AGENT_DIR is the documented escape hatch for hermetic
 * runs.
 */
function defaultAgentDir(): string {
	const env = process.env.PI_CODING_AGENT_DIR;
	if (env) return env.startsWith("~") ? join(homedir(), env.slice(1)) : env;
	return join(homedir(), ".omp", "agent");
}

/**
 * Real SDK bootstrap, mirroring server/index.ts (discoverAuthStorage +
 * Settings.init) and server/collab-session.ts createSession (the full
 * createAgentSession call with hasUI: false). Throws on any failure — the
 * caller's catch turns it into null.
 */
async function bootstrapSession(cwd: string, agentDir: string): Promise<SessionLike> {
	// Lazy import is a hard contract: this script must load — and its unit
	// tests must pass — with no SDK present, so release.ts can degrade to the
	// deterministic changelog. A static import would defeat that.
	const sdk = await import("@oh-my-pi/pi-coding-agent");
	const { AgentRegistry } = await import("@oh-my-pi/pi-coding-agent/registry/agent-registry");
	const { EventBus } = await import("@oh-my-pi/pi-coding-agent/utils/event-bus");
	const authStorage = await sdk.discoverAuthStorage(agentDir);
	const modelRegistry = new sdk.ModelRegistry(authStorage);
	const settings = await sdk.Settings.init({ cwd, agentDir });
	// Default-role model gate (mirrors fleet/omp-check.ts): without a
	// configured default model there is nothing to prompt.
	const roles = settings.get("modelRoles") as Record<string, unknown> | undefined;
	const defaultSelector = roles?.default;
	if (typeof defaultSelector !== "string" || defaultSelector === "") {
		throw new Error("no default model configured (settings.modelRoles.default)");
	}
	const sessionManager = sdk.SessionManager.create(cwd);
	const agentRegistry = new AgentRegistry();
	const eventBus = new EventBus();
	const { session: sdkSession } = await sdk.createAgentSession({
		cwd,
		agentDir,
		authStorage,
		modelRegistry,
		settings,
		sessionManager,
		agentRegistry,
		eventBus,
		hasUI: false,
	});
	return {
		prompt: (text: string) => sdkSession.prompt(text),
		// The SDK's teardown is dispose(); expose it as the destroy seam.
		destroy: () => sdkSession.dispose(),
		// SDK prompt() resolves to a boolean — the final assistant text arrives
		// as the agent_end/message_end events subscribers see. The (event:
		// unknown) listener is assignable (AgentSessionEvent → unknown).
		subscribe: (listener: (event: unknown) => void) => sdkSession.subscribe(listener),
	};
}

/** Validate a sessionFactory result and narrow it to the SessionLike surface. */
function normalizeFactorySession(created: unknown): SessionLike {
	if (!isObject(created)) {
		throw new Error("sessionFactory did not return { session }");
	}
	const session = created.session;
	if (!isObject(session)) {
		throw new Error("sessionFactory did not return { session }");
	}
	const prompt = session.prompt;
	const destroy = session.destroy;
	if (typeof prompt !== "function") {
		throw new Error("sessionFactory session has no prompt()");
	}
	// Contract members checked above; narrowed to the declared shapes.
	const promptFn = prompt as (text: string) => Promise<unknown>;
	const destroyFn =
		typeof destroy === "function" ? (destroy as () => void | Promise<void>) : undefined;
	return {
		prompt: (text: string) => promptFn(text),
		...(destroyFn ? { destroy: () => destroyFn() } : {}),
	};
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

/**
 * One turn: race prompt() against the timeout while collecting the final
 * assistant text from events. Resolves the assistant text, or null on
 * timeout/rejection/no text. Does NOT destroy the session — the caller owns
 * teardown across the multi-turn run.
 */
async function runTurn(
	session: SessionLike,
	promptText: string,
	timeoutMs: number,
): Promise<string | null> {
	let capturedText: string | null = null;
	let unsubscribe: (() => void) | undefined;
	if (typeof session.subscribe === "function") {
		unsubscribe = session.subscribe((event) => {
			if (!isObject(event)) return;
			if (event.type === "agent_end" && Array.isArray(event.messages)) {
				const text = assistantTextFromMessages(event.messages);
				if (text !== null && text !== "") capturedText = text;
			} else if (event.type === "message_end" && isObject(event.message)) {
				const text = assistantTextFromMessages([event.message]);
				if (text !== null && text !== "") capturedText = text;
			}
		});
	}
	try {
		const settled = await withTimeout(session.prompt(promptText), timeoutMs);
		if (!settled.ok) return null; // timed out
		// The factory seam's prompt resolves to the assistant text itself; the
		// real SDK resolves a boolean and the text arrives via events.
		const raw = settled.value;
		if (typeof raw === "string" && raw.trim() !== "") return raw;
		return capturedText;
	} finally {
		unsubscribe?.();
	}
}

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
 * Final assistant text from a message list: the last assistant message that
 * carries text blocks (tool-only assistant messages are skipped).
 */
function assistantTextFromMessages(messages: unknown[]): string | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (!isObject(message) || message.role !== "assistant") continue;
		const content = message.content;
		if (!Array.isArray(content)) continue;
		const parts: string[] = [];
		for (const block of content) {
			if (isObject(block) && block.type === "text" && typeof block.text === "string") {
				parts.push(block.text);
			}
		}
		if (parts.length > 0) return parts.join("\n");
	}
	return null;
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
