/**
 * Lenient JSONL access for session transcripts.
 *
 * Session files can be huge (11 MB+), truncated by crashes, or contain
 * corrupt trailing lines. Every parse is defensive.
 *
 * ONE shared parse per (abs, mtimeMs, size): an LRU cache (max 100 docs)
 * plus in-flight dedup, so concurrent callers for the same file share a
 * single read + parse. Corrupt lines are skipped in `entries` but never
 * shift paging: `lineIndex[i]` holds the raw 0-based JSONL line number of
 * `entries[i]`, and `readRange` pages over RAW line windows
 * [offset, offset+limit) — a corrupt line inside the window only yields a
 * gap, and the next page can never duplicate or drop entries.
 *
 * Byte cap: files larger than MAX_JSONL_BYTES are parsed only up to the
 * last complete line at/before the cap; `truncated: true` marks the doc.
 * PI_MAX_JSONL_BYTES (bytes) overrides the cap at call time — a test seam;
 * note the cache key deliberately does not include the cap, so tests must
 * use distinct files per cap value.
 *
 * Entry timestamp resolution (PLAN.md §2.2): prefer message.timestamp
 * (epoch ms) when present, else Date.parse(entry.timestamp).
 */
import { open, readFile, stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import type { RawEntry } from "../../../shared/stats-types";

const MAX_LINE_BYTES = 4 * 1024 * 1024;

/** Parse cap for oversized files: stop at the last complete line at/before this byte offset. */
export const MAX_JSONL_BYTES = 256 * 1024 * 1024;

/** Effective cap at call time; PI_MAX_JSONL_BYTES (bytes) overrides the default (test seam). */
function maxJsonlBytes(): number {
	const v = Number(process.env.PI_MAX_JSONL_BYTES);
	return Number.isFinite(v) && v > 0 ? Math.floor(v) : MAX_JSONL_BYTES;
}

const CACHE_MAX = 100;
const docCache = new Map<string, JsonlDoc>();
const inflight = new Map<string, Promise<JsonlDoc | null>>();
let cacheHits = 0;
let cacheMisses = 0;

export interface JsonlDoc {
	/** Parsed entries only — corrupt lines are skipped. */
	entries: RawEntry[];
	/** Raw 0-based JSONL line number for entries[i]. */
	lineIndex: number[];
	/** Raw line count including corrupt lines. */
	totalLines: number;
	/** True when the file exceeded the byte cap and was parsed only up to it. */
	truncated: boolean;
}

/** Diagnostics: cache hits/misses since module load (hits include in-flight joins). */
export function jsonlCacheStats(): { hits: number; misses: number } {
	return { hits: cacheHits, misses: cacheMisses };
}

function cacheKey(abs: string, mtimeMs: number, size: number): string {
	return `${abs}\u0000${mtimeMs}\u0000${size}`;
}

export function parseLine(line: string): RawEntry | null {
	if (!line.trim()) return null;
	if (line.length > MAX_LINE_BYTES) return null; // pathological line; skip
	try {
		const o = JSON.parse(line);
		return typeof o === "object" && o !== null ? (o as RawEntry) : null;
	} catch {
		return null;
	}
}

/**
 * Load + parse a session file, cached by (abs, mtimeMs, size).
 * Returns null when the file is missing or unreadable (never cached).
 */
export async function loadJsonl(abs: string): Promise<JsonlDoc | null> {
	let st: Awaited<ReturnType<typeof stat>>;
	try {
		st = await stat(abs);
	} catch {
		return null; // missing — no mtime/size to key on
	}
	if (!st.isFile()) return null;
	const key = cacheKey(abs, st.mtimeMs, st.size);
	const cached = docCache.get(key);
	if (cached) {
		cacheHits++;
		docCache.delete(key); // refresh LRU recency
		docCache.set(key, cached);
		return cached;
	}
	const pending = inflight.get(key);
	if (pending) {
		cacheHits++;
		return pending;
	}
	cacheMisses++;
	const p = parseDoc(abs, st)
		.then((doc) => {
			docCache.set(key, doc);
			if (docCache.size > CACHE_MAX) {
				const oldest = docCache.keys().next().value;
				if (oldest !== undefined) docCache.delete(oldest);
			}
			return doc;
		})
		.catch(() => null) // unreadable — do not cache; the next call retries
		.finally(() => {
			inflight.delete(key);
		});
	inflight.set(key, p);
	return p;
}

/** Parse a file whose stat we already have, honoring the byte cap. */
async function parseDoc(abs: string, st: Stats): Promise<JsonlDoc> {
	const cap = maxJsonlBytes();
	let text: string;
	let truncated = false;
	if (st.size > cap) {
		truncated = true;
		text = await readPrefix(abs, cap);
		const nl = text.lastIndexOf("\n");
		text = nl >= 0 ? text.slice(0, nl) : ""; // keep only complete lines
	} else {
		text = await readFile(abs, "utf8");
	}
	const lines = text.length === 0 ? [] : text.split("\n");
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop(); // file ends with \n
	const entries: RawEntry[] = [];
	const lineIndex: number[] = [];
	for (let i = 0; i < lines.length; i++) {
		const e = parseLine(lines[i]!);
		if (e) {
			entries.push(e);
			lineIndex.push(i);
		}
	}
	return { entries, lineIndex, totalLines: lines.length, truncated };
}

/** First `cap` bytes of a file, without buffering the whole thing. */
async function readPrefix(abs: string, cap: number): Promise<string> {
	const fh = await open(abs, "r");
	try {
		const buf = Buffer.alloc(cap);
		const { bytesRead } = await fh.read(buf, 0, cap, 0);
		return buf.toString("utf8", 0, bytesRead);
	} finally {
		await fh.close();
	}
}

export interface RangeResult {
	entries: RawEntry[];
	/** Raw line index of the next page, or null at EOF. */
	nextOffset: number | null;
	totalLines: number;
}

/**
 * Paginated read over the RAW line window [startLine, startLine+limit).
 * Corrupt lines inside the window yield gaps (skipped), never duplicates.
 */
export async function readRange(
	file: string,
	startLine: number,
	limit: number,
): Promise<RangeResult> {
	const doc = await loadJsonl(file);
	if (!doc) return { entries: [], nextOffset: null, totalLines: 0 };
	const { entries, lineIndex, totalLines } = doc;
	const end = startLine + limit;
	// First entry at/after startLine (lineIndex is ascending).
	let lo = 0;
	let hi = lineIndex.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (lineIndex[mid]! < startLine) lo = mid + 1;
		else hi = mid;
	}
	const out: RawEntry[] = [];
	for (let i = lo; i < lineIndex.length && lineIndex[i]! < end; i++) {
		out.push(entries[i]!);
	}
	return { entries: out, nextOffset: end < totalLines ? end : null, totalLines };
}

/** Epoch ms for an entry: message.timestamp (epoch ms) else Date.parse(entry.timestamp). */
export function entryTs(e: RawEntry): number | null {
	const msg = (e.message ?? null) as { timestamp?: unknown } | null;
	if (msg && typeof msg.timestamp === "number" && Number.isFinite(msg.timestamp)) {
		return msg.timestamp;
	}
	if (typeof e.timestamp === "string") {
		const t = Date.parse(e.timestamp);
		return Number.isFinite(t) ? t : null;
	}
	return null;
}

/**
 * Tool-execution start marker (`custom` entry with customType
 * "tool_execution_start"). Returns the toolCallId and the execution start as
 * epoch ms — data.startedAt when present (ISO string or epoch ms), else the
 * entry's own timestamp — or null when the entry isn't a usable marker.
 */
export function toolExecutionStart(
	e: RawEntry,
): { toolCallId: string; startedAtMs: number } | null {
	if (e.type !== "custom" || e.customType !== "tool_execution_start") return null;
	const data = (e.data ?? null) as { toolCallId?: unknown; startedAt?: unknown } | null;
	const id = data?.toolCallId;
	if (typeof id !== "string") return null;
	let ms: number | null = null;
	const sa = data?.startedAt;
	if (typeof sa === "number" && Number.isFinite(sa)) ms = sa;
	else if (typeof sa === "string") {
		const p = Date.parse(sa);
		if (!Number.isNaN(p)) ms = p;
	} else if (typeof e.timestamp === "string") {
		const p = Date.parse(e.timestamp);
		if (!Number.isNaN(p)) ms = p;
	}
	return ms === null ? null : { toolCallId: id, startedAtMs: ms };
}

export interface ToolCallBlock {
	id: string;
	name: string;
	args: unknown;
	argsChars: number;
}

export interface AssistantMsg {
	role: "assistant";
	content?: Array<Record<string, unknown>>;
	timestamp?: unknown;
	stopReason?: unknown;
}

export function isAssistant(e: RawEntry): e is RawEntry & { message: AssistantMsg } {
	const m = e.message as AssistantMsg | undefined;
	return !!m && m.role === "assistant";
}

export function isToolResult(
	e: RawEntry,
): e is RawEntry & { message: { role: "toolResult"; toolCallId: string } } {
	const m = e.message as { role?: string; toolCallId?: string } | undefined;
	return !!m && m.role === "toolResult" && typeof m.toolCallId === "string";
}

export function toolCallsOf(e: RawEntry): ToolCallBlock[] {
	const m = e.message as AssistantMsg | undefined;
	const content = m?.content;
	if (!Array.isArray(content)) return [];
	const out: ToolCallBlock[] = [];
	for (const b of content) {
		if (b && b.type === "toolCall" && typeof b.id === "string" && typeof b.name === "string") {
			let args: unknown = b.arguments;
			if (typeof args === "string") {
				try {
					args = JSON.parse(args);
				} catch {
					/* keep raw string */
				}
			}
			out.push({ id: b.id, name: b.name, args, argsChars: JSON.stringify(args).length });
		}
	}
	return out;
}

/** Concatenated text of a toolResult's content blocks. */
export function resultText(e: RawEntry): string {
	const m = e.message as { content?: Array<{ type?: string; text?: unknown }> } | undefined;
	const content = m?.content;
	if (!Array.isArray(content)) return "";
	let s = "";
	for (const b of content) {
		if (b && typeof b.text === "string") s += b.text;
	}
	return s;
}
