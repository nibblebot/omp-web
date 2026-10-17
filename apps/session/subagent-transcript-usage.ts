// Durable usage for a finished subagent: its child transcript records every assistant turn.
// Accounting mirrors the task executor's progress accounting (task/executor.ts getUsageTokens):
// a request per assistant message, tokens per turn = input + output + cacheWrite (cacheRead is
// excluded because it repeats the whole cached context each turn), falling back to totalTokens
// only when that sum is zero, and cost from usage.cost.total. Missing or unreadable files stay unknown.
import { readFile } from "node:fs/promises";
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

export async function transcriptUsage(
	sessionFile: string,
): Promise<SubagentUsageFields | undefined> {
	let text: string;
	try {
		text = await readFile(sessionFile, "utf8");
	} catch {
		return undefined;
	}
	let requests = 0;
	let tokens = 0;
	let cost = 0;
	for (const line of text.split("\n")) {
		if (!line.includes('"role":"assistant"')) continue;
		let entry: TranscriptLine;
		try {
			entry = JSON.parse(line) as TranscriptLine;
		} catch {
			continue;
		}
		if (entry.message?.role !== "assistant") continue;
		requests += 1;
		const usage = entry.message.usage ?? {};
		tokens += tokensOf(usage);
		cost += usage.cost?.total ?? 0;
	}
	return requests === 0 ? undefined : { tokens, requests, cost };
}
