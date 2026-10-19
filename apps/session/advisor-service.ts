// Advisor service: read-model + enable/history over the session advisors.
//
// Server owns durable agent state; apps/web/store/* owns normalized mirrors;
// this module is the pure service layer. No side effects at import time.
// All DTOs are JSON-safe. Errors are plain Errors without paths.

// Provenance note: note/concern/blocker severity lives in the advise-tool
// `<advisory severity>` stream, not in any dump here. Consumers render
// severity from live events; the history dump below is deliberately raw.

import { resolveAdvisorRoleSelection } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import type { SessionEntry } from "./session-entry";

export interface AdvisorListEntry {
	name: string;
	status: string;
	yielded: boolean;
}

export interface AdvisorOverview {
	configured: boolean;
	/** True when the `advisor` model role resolves to an available model (the SDK's no_model check). */
	roleResolvable: boolean;
	active: boolean;
	advisors: AdvisorListEntry[];
}

interface AdvisorTokens {
	input: number;
	output: number;
	reasoning: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
}

interface AdvisorMessages {
	user: number;
	assistant: number;
	total: number;
}

export interface AdvisorStatEntry {
	name: string;
	status: string;
	cost: number;
	contextTokens: number;
}

export interface AdvisorStatsDto {
	configured: boolean;
	active: boolean;
	cost: number;
	tokens: AdvisorTokens;
	messages: AdvisorMessages;
	contextTokens: number;
	contextWindow: number;
	advisors: AdvisorStatEntry[];
}

function num(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function zeroStats(configured: boolean): AdvisorStatsDto {
	return {
		configured,
		active: false,
		cost: 0,
		tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		messages: { user: 0, assistant: 0, total: 0 },
		contextTokens: 0,
		contextWindow: 0,
		advisors: [],
	};
}

export function getAdvisorOverview(entry: SessionEntry): AdvisorOverview {
	const overview = entry.session.getAdvisorStatusOverview();
	return {
		configured: overview.configured === true,
		roleResolvable:
			resolveAdvisorRoleSelection(
				entry.session.settings,
				entry.session.modelRegistry.getAvailable(),
			) !== undefined,
		active: entry.session.isAdvisorActive(),
		advisors: (overview.advisors ?? []).map((item) => ({
			name: String(item.name),
			status: String(item.status),
			yielded: item.yielded === true,
		})),
	};
}

/**
 * Calls the REAL session enable (boolean return = actively running after the
 * call), then reports fresh active state. Never a hide-panel-only toggle.
 */
export function setAdvisorEnabled(
	entry: SessionEntry,
	enabled: boolean,
): { enabled: boolean; active: boolean } {
	entry.session.setAdvisorEnabled(enabled);
	return { enabled, active: entry.session.isAdvisorActive() };
}

export function getAdvisorStats(entry: SessionEntry): AdvisorStatsDto {
	let configured = false;
	try {
		configured = entry.session.isAdvisorEnabled();
	} catch {
		configured = false;
	}
	try {
		const stats = entry.session.getAdvisorStats();
		return {
			configured: stats.configured === true,
			active: stats.active === true,
			cost: num(stats.cost),
			tokens: {
				input: num(stats.tokens?.input),
				output: num(stats.tokens?.output),
				reasoning: num(stats.tokens?.reasoning),
				cacheRead: num(stats.tokens?.cacheRead),
				cacheWrite: num(stats.tokens?.cacheWrite),
				total: num(stats.tokens?.total),
			},
			messages: {
				user: num(stats.messages?.user),
				assistant: num(stats.messages?.assistant),
				total: num(stats.messages?.total),
			},
			contextTokens: num(stats.contextTokens),
			contextWindow: num(stats.contextWindow),
			advisors: (stats.advisors ?? []).map((item) => ({
				name: String(item.name),
				status: String(item.status),
				cost: num(item.cost),
				contextTokens: num(item.contextTokens),
			})),
		};
	} catch {
		return zeroStats(configured);
	}
}

export function getAdvisorWarnings(entry: SessionEntry): { warnings: string[] } {
	return { warnings: [...entry.session.getAdvisorConfigWarnings()] };
}
