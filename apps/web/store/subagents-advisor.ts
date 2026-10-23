import { call } from "./transport";
import { asBoolean, asNumber, asRecord, asString } from "./subagents";

/**
 * Advisor store. Server DTO read models and tolerant
 * coercers for the advisor wire methods.
 */

// ---------------------------------------------------------------------------
// Advisors. Server DTO read models. All three
// getters read advisorGetStatus with a section arg and coerce their section
// out of whatever record arrives (single-shape replies tolerated).
// ---------------------------------------------------------------------------

export interface AdvisorOverview {
	configured: boolean;
	/** The advisor model role resolves to an available model; false means none is assigned. */
	roleResolvable: boolean;
	active: boolean;
	advisors: Array<{ name: string; status: string; yielded: boolean }>;
}

function coerceAdvisorOverview(data: unknown): AdvisorOverview {
	const r = asRecord(data);
	if (r === null) return { configured: false, roleResolvable: false, active: false, advisors: [] };
	const field = r.advisors;
	const list = Array.isArray(field) ? field : [];
	const advisors: AdvisorOverview["advisors"] = [];
	for (const row of list) {
		const ar = asRecord(row);
		if (ar === null) continue;
		const name = asString(ar.name);
		if (name === undefined || name === "") continue;
		advisors.push({
			name,
			status: asString(ar.status) ?? "",
			yielded: asBoolean(ar.yielded) ?? false,
		});
	}
	return {
		configured: asBoolean(r.configured) ?? false,
		roleResolvable: asBoolean(r.roleResolvable) ?? false,
		active: asBoolean(r.active) ?? false,
		advisors,
	};
}

/** Server read; unavailable operations reject to the caller. */
export async function getAdvisorOverview(): Promise<AdvisorOverview> {
	return coerceAdvisorOverview(await call("advisorGetStatus", [{ section: "overview" }]));
}

/** Enable/disable advisors; rejects (throws to caller) on server failure. */
export function setAdvisorEnabled(
	enabled: boolean,
): Promise<{ enabled: boolean; active: boolean }> {
	return call("advisorConfigure", [{ enabled }]).then((data) => {
		const r: Record<string, unknown> = asRecord(data) ?? {};
		return {
			enabled: asBoolean(r.enabled) ?? enabled,
			active: asBoolean(r.active) ?? false,
		};
	});
}

export interface AdvisorStatsDto {
	configured: boolean;
	active: boolean;
	cost: number;
	tokens: {
		input: number;
		output: number;
		reasoning: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	messages: { user: number; assistant: number; total: number };
	contextTokens: number;
	contextWindow: number;
	advisors: Array<{ name: string; status: string; cost: number; contextTokens: number }>;
}

function coerceAdvisorStats(data: unknown): AdvisorStatsDto {
	const zero: AdvisorStatsDto = {
		configured: false,
		active: false,
		cost: 0,
		tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		messages: { user: 0, assistant: 0, total: 0 },
		contextTokens: 0,
		contextWindow: 0,
		advisors: [],
	};
	const r = asRecord(data);
	if (r === null) return zero;
	const tokens: Record<string, unknown> = asRecord(r.tokens) ?? {};
	const messages: Record<string, unknown> = asRecord(r.messages) ?? {};
	const field = r.advisors;
	const list = Array.isArray(field) ? field : [];
	const advisors: AdvisorStatsDto["advisors"] = [];
	for (const row of list) {
		const ar = asRecord(row);
		if (ar === null) continue;
		const name = asString(ar.name);
		if (name === undefined || name === "") continue;
		advisors.push({
			name,
			status: asString(ar.status) ?? "",
			cost: asNumber(ar.cost) ?? 0,
			contextTokens: asNumber(ar.contextTokens) ?? 0,
		});
	}
	return {
		configured: asBoolean(r.configured) ?? false,
		active: asBoolean(r.active) ?? false,
		cost: asNumber(r.cost) ?? 0,
		tokens: {
			input: asNumber(tokens.input) ?? 0,
			output: asNumber(tokens.output) ?? 0,
			reasoning: asNumber(tokens.reasoning) ?? 0,
			cacheRead: asNumber(tokens.cacheRead) ?? 0,
			cacheWrite: asNumber(tokens.cacheWrite) ?? 0,
			total: asNumber(tokens.total) ?? 0,
		},
		messages: {
			user: asNumber(messages.user) ?? 0,
			assistant: asNumber(messages.assistant) ?? 0,
			total: asNumber(messages.total) ?? 0,
		},
		contextTokens: asNumber(r.contextTokens) ?? 0,
		contextWindow: asNumber(r.contextWindow) ?? 0,
		advisors,
	};
}

/** Server read; unavailable operations reject to the caller. */
export async function getAdvisorStats(): Promise<AdvisorStatsDto> {
	return coerceAdvisorStats(await call("advisorGetStatus", [{ section: "stats" }]));
}

/** Server read; unavailable operations reject to the caller. */
export async function getAdvisorWarnings(): Promise<{ warnings: string[] }> {
	const data = await call("advisorGetStatus", [{ section: "warnings" }]);
	if (Array.isArray(data))
		return { warnings: data.filter((v): v is string => typeof v === "string") };
	const field = asRecord(data)?.warnings;
	return {
		warnings: Array.isArray(field) ? field.filter((v): v is string => typeof v === "string") : [],
	};
}

/** Server read; unavailable operations reject to the caller. */
export async function getAdvisorHistory(opts?: {
	compact?: boolean;
	fromByte?: number;
}): Promise<{ available: boolean; text: string | null; reason?: string }> {
	const data = await call("advisorTranscript", opts !== undefined ? [opts] : []);
	const r = asRecord(data);
	if (r === null) return { available: false, text: null };
	const entry: { available: boolean; text: string | null; reason?: string } = {
		available: asBoolean(r.available) ?? false,
		text: asString(r.text) ?? null,
	};
	const reason = asString(r.reason);
	if (reason !== undefined) entry.reason = reason;
	return entry;
}
