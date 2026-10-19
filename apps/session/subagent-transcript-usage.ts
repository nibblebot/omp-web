// Durable usage for a finished subagent: its child transcript records every assistant turn.
// Accounting mirrors the task executor's progress accounting (task/executor.ts getUsageTokens):
// a request per assistant message, tokens per turn = input + output + cacheWrite (cacheRead is
// excluded because it repeats the whole cached context each turn), falling back to totalTokens
// only when that sum is zero, and cost from usage.cost.total. Missing or unreadable files stay unknown.
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { SubagentUsageFields } from "#lib/wire/protocol";

interface TranscriptUsage {
	input?: number;
	output?: number;
	cacheWrite?: number;
	totalTokens?: number;
	cost?: { total?: number };
}

// Boundary type for one JSONL line written by the session runtime.
interface TranscriptLine {
	message?: { role?: string; usage?: TranscriptUsage };
}

function tokensOf(usage: TranscriptUsage): number {
	const computed = (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheWrite ?? 0);
	return computed > 0 ? computed : (usage.totalTokens ?? 0);
}

interface UsageTotals {
	requests: number;
	tokens: number;
	cost: number;
}

function addLine(line: string, totals: UsageTotals): void {
	if (!line.includes('"role":"assistant"')) return;
	let entry: TranscriptLine;
	try {
		entry = JSON.parse(line) as TranscriptLine;
	} catch {
		return;
	}
	if (entry.message?.role !== "assistant") return;
	totals.requests += 1;
	const usage = entry.message.usage ?? {};
	totals.tokens += tokensOf(usage);
	totals.cost += usage.cost?.total ?? 0;
}

// Streams the transcript in chunks; only a partial trailing line is carried between chunks.
async function scanTranscript(sessionFile: string): Promise<SubagentUsageFields | undefined> {
	const totals: UsageTotals = { requests: 0, tokens: 0, cost: 0 };
	let carry = "";
	for await (const chunk of createReadStream(sessionFile, { encoding: "utf8" })) {
		const lines = `${carry}${chunk}`.split("\n");
		carry = lines.pop() ?? "";
		for (const line of lines) addLine(line, totals);
	}
	addLine(carry, totals);
	return totals.requests === 0 ? undefined : { ...totals };
}

interface UsageCacheEntry {
	size: number;
	mtimeMs: number;
	usage: SubagentUsageFields | undefined;
}

// Finished transcripts are immutable; keying by size and mtime re-scans only a rewritten file.
const USAGE_CACHE_LIMIT = 256;
const usageCache = new Map<string, UsageCacheEntry>();

export async function transcriptUsage(
	sessionFile: string,
	scan: (file: string) => Promise<SubagentUsageFields | undefined> = scanTranscript,
): Promise<SubagentUsageFields | undefined> {
	const info = await stat(sessionFile).catch(() => undefined);
	if (!info?.isFile()) return undefined;
	const cached = usageCache.get(sessionFile);
	if (cached?.size === info.size && cached.mtimeMs === info.mtimeMs) return cached.usage;
	let usage: SubagentUsageFields | undefined;
	try {
		usage = await scan(sessionFile);
	} catch {
		return undefined;
	}
	usageCache.delete(sessionFile);
	if (usageCache.size >= USAGE_CACHE_LIMIT) {
		const oldest = usageCache.keys().next();
		if (!oldest.done) usageCache.delete(oldest.value);
	}
	usageCache.set(sessionFile, { size: info.size, mtimeMs: info.mtimeMs, usage });
	return usage;
}
