/**
 * Large-history transcript fixture for scenario S1. Generated once, cached
 * under `<outRoot>/fixtures/`, copied per run into the session directory the
 * fleet's session daemon resumes from. Records follow the SDK's session JSONL
 * v3 shapes (header, then a parent-linked chain of `message` entries) so the
 * real resume path (`--resume <file>`, history priming, listing) runs.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROFILE_MODEL_ID, PROFILE_PROVIDER } from "./fake-model/config";

export interface HistoryShape {
	/** User -> assistant(text + bash call) -> toolResult -> assistant(final text) rounds. */
	turns: number;
	/** Bytes of each tool result's text. */
	toolOutputBytes: number;
	/** Characters of each assistant text block. */
	textChars: number;
}

/**
 * Sub-threshold fixture, about 3.4 MiB on the wire. Measured on this host with
 * the pinned harness client over thousands of rapid attaches: 150 to 350 rounds
 * never dropped or re-primed an attach; 400 rounds (4.5 MiB) already does
 * (about 0.4% dropped, a few percent re-primed) and 800 rounds (8.9 MiB)
 * drops about 14%. 300 keeps a margin below the first failing size.
 */
export const SUB_THRESHOLD_HISTORY: HistoryShape = {
	turns: 300,
	toolOutputBytes: 8192,
	textChars: 1200,
};

/** About 23 MiB on the wire: far past the edge's drop point, so attaches of it are dropped often. */
export const LARGE_HISTORY: HistoryShape = { turns: 2000, toolOutputBytes: 8192, textChars: 1200 };

export const CWD_PLACEHOLDER = "__PROFILE_CWD__";
const SESSION_ID_PLACEHOLDER = "__PROFILE_SESSION_ID__";

function hex8(n: number): string {
	return createHash("sha1").update(String(n)).digest("hex").slice(0, 8);
}

/** Deterministic filler text: stable bytes for a given (seed, length), no repetition runs a compressor would erase. */
function filler(seed: number, length: number): string {
	const words = [
		"alpha",
		"bravo",
		"delta",
		"ember",
		"forge",
		"gamma",
		"helix",
		"iris",
		"jade",
		"kilo",
	];
	let out = "";
	let state = seed * 2654435761;
	while (out.length < length) {
		state = (state * 1103515245 + 12345) >>> 0;
		out += `${words[state % words.length]}${(state >>> 8) % 997} `;
	}
	return out.slice(0, length);
}

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** The JSONL text of a large history (header uses placeholders; see `materializeHistory`). */
export function buildHistoryJsonl(shape: HistoryShape): string {
	const lines: string[] = [];
	const baseMs = Date.UTC(2026, 0, 1);
	lines.push(
		JSON.stringify({
			type: "session",
			version: 3,
			id: SESSION_ID_PLACEHOLDER,
			timestamp: new Date(baseMs).toISOString(),
			cwd: CWD_PLACEHOLDER,
		}),
	);
	let parent: string | null = null;
	let counter = 0;
	let clock = baseMs;
	const push = (message: Record<string, unknown>): void => {
		const id = hex8(++counter);
		clock += 1000;
		lines.push(
			JSON.stringify({
				type: "message",
				id,
				parentId: parent,
				timestamp: new Date(clock).toISOString(),
				runtime: { version: "18.11.0" },
				message: { ...message, timestamp: clock },
			}),
		);
		parent = id;
	};
	const assistant = (content: unknown[], stopReason: string): Record<string, unknown> => ({
		role: "assistant",
		content,
		api: "openai-completions",
		provider: PROFILE_PROVIDER,
		model: PROFILE_MODEL_ID,
		usage,
		stopReason,
	});
	for (let turn = 0; turn < shape.turns; turn++) {
		const callId = `call_${turn}`;
		push({
			role: "user",
			content: [{ type: "text", text: `History round ${turn}: ${filler(turn, 120)}` }],
			attribution: "user",
		});
		push(
			assistant(
				[
					{ type: "text", text: filler(turn * 3 + 1, shape.textChars) },
					{
						type: "toolCall",
						id: callId,
						name: "bash",
						arguments: { command: `echo round ${turn}` },
					},
				],
				"toolUse",
			),
		);
		push({
			role: "toolResult",
			toolCallId: callId,
			toolName: "bash",
			content: [{ type: "text", text: filler(turn * 3 + 2, shape.toolOutputBytes) }],
			isError: false,
		});
		push(assistant([{ type: "text", text: filler(turn * 3 + 3, shape.textChars) }], "stop"));
	}
	return `${lines.join("\n")}\n`;
}

/** Cached fixture path under `fixturesDir`, generated on first use. Atomic via rename. */
export function ensureHistoryFixture(fixturesDir: string, shape: HistoryShape): string {
	const name = `history-t${shape.turns}-b${shape.toolOutputBytes}-c${shape.textChars}.jsonl`;
	const path = join(fixturesDir, name);
	if (existsSync(path)) return path;
	mkdirSync(fixturesDir, { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, buildHistoryJsonl(shape));
	renameSync(tmp, path);
	return path;
}

/**
 * Copy the cached fixture into `sessionDir` as a session file for `cwd`
 * (`<timestamp>_<id>.jsonl`, the SDK's naming) and return its path.
 */
export async function materializeHistory(
	fixture: string,
	sessionDir: string,
	cwd: string,
): Promise<string> {
	mkdirSync(sessionDir, { recursive: true });
	const sessionId = crypto.randomUUID();
	const text = (await Bun.file(fixture).text())
		.replace(SESSION_ID_PLACEHOLDER, sessionId)
		.replace(CWD_PLACEHOLDER, cwd);
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const path = join(sessionDir, `${stamp}_${sessionId}.jsonl`);
	await Bun.write(path, text);
	return path;
}
