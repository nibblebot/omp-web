/**
 * LLM-assisted changelog summarizer for the release machinery (release-plan.md
 * step 3, "Changelog (LLM-assisted, deterministic structure)").
 *
 * One-turn SDK session over the grouped commit list → a release overview
 * paragraph + polished per-commit bullets. Best-effort by design: every
 * failure path returns null and the caller falls back to the deterministic
 * skeleton (raw subjects, no overview). Never throws.
 *
 * The SDK is imported LAZILY inside the bootstrap — this module's top level
 * imports only node: builtins, so loading the script never pulls the agent
 * stack (the same lazy-import philosophy as fleet/omp-check.ts).
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
	/** Per-turn wall-clock budget; default 120s. */
	timeoutMs?: number;
	/**
	 * Test seam: replaces the real SDK bootstrap entirely (no SDK import, no
	 * auth storage, no settings). Receives the bootstrap deps object and must
	 * return a `{ session: { prompt(text): Promise<unknown>; destroy?() } }`
	 * shaped object. `prompt` should resolve to the final assistant text (a
	 * string) — the seam has no event subscription, so text is taken from the
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
const DEFAULT_TIMEOUT_MS = 120_000;
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
		const text = await runTurn(session, buildPrompt(input), opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
		if (text === null) return null;
		return parseDraft(text);
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
 * Deterministic prompt: fixed instruction block (version embedded), the
 * grouped commit list as `### <heading>` + `- <hash> <subject>`, then the
 * strict single-JSON-object output contract.
 */
function buildPrompt(input: SummarizeInput): string {
	const lines: string[] = [
		`You are writing the changelog for omp-web ${input.version}.`,
		"Rewrite each commit below as a polished, user-facing release-note bullet:",
		"- One bullet per commit, in its group, ending with that commit's hash link.",
		"- Imperative voice, at most 20 words per bullet, plain prose.",
		"- Keep every commit; never invent or drop commits.",
		"",
		"Commits to summarize:",
	];
	for (const group of input.groups) {
		lines.push(`### ${group.heading}`);
		for (const commit of group.commits) {
			lines.push(`- ${commit.hash} ${commit.subject}`);
		}
	}
	lines.push(
		"",
		"Output ONLY a single JSON object — no prose, no markdown, no code fences — in this shape:",
		`{ "overview": "<1-3 sentence release summary>", "groups": [{ "cls": "feat", "bullets": ` +
			`["<bullet> ([<hash>](${COMMIT_LINK_BASE}<hash>))"] }] }`,
		'- "cls" must be one of: "breaking", "feat", "fix", "other".',
		"- Every bullet must end with its commit hash link " + `([<hash>](${COMMIT_LINK_BASE}<hash>)).`,
		'- "overview" may be an empty string only if you cannot summarize; never invent commits.',
	);
	return lines.join("\n");
}

/**
 * One turn: race prompt() against the timeout while collecting the final
 * assistant text from events. Resolves the assistant text, or null on
 * timeout/rejection/no text. Always destroys the session.
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
		if (typeof session.destroy === "function") {
			try {
				await session.destroy();
			} catch {
				// Never-throw contract: teardown failures are not results.
			}
		}
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

/** Parse and shape-validate the model's JSON output; null on any mismatch. */
function parseDraft(text: string): ChangelogDraft | null {
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
	if (!Array.isArray(obj.groups)) return null;
	const groups: ChangelogDraft["groups"] = [];
	for (const group of obj.groups) {
		if (!isObject(group) || Array.isArray(group)) return null;
		const g = group as Record<string, unknown>;
		if (typeof g.cls !== "string" || COMMIT_CLASSES[g.cls] !== true) return null;
		if (!Array.isArray(g.bullets) || !g.bullets.every((b) => typeof b === "string")) return null;
		const cls = g.cls as CommitClass;
		const bullets = g.bullets as string[];
		groups.push({ cls, bullets });
	}
	return {
		// An empty overview means "could not summarize" → omit the paragraph.
		overview: obj.overview.trim() === "" ? null : obj.overview,
		groups,
	};
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
