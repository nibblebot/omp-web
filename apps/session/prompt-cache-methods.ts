/**
 * `getPromptCacheStatus` for the web's cache indicator: what the next request finds in the prompt
 * cache. Read-only (READ_ONLY_METHODS). The answer carries the SDK's own text for the hover card
 * (`promptCacheBrief`) and the `/session` rows (`promptCacheDetails`), computed at answer time, so the
 * browser keeps no second copy of the wording rules.
 */

import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { PromptCacheStatus } from "@oh-my-pi/pi-tui/status-line/host";
import { promptCacheBrief, promptCacheDetails } from "@oh-my-pi/pi-tui/status-line/prompt-cache";
import type { PromptCacheStatusDto, PromptCacheStatusReply } from "#lib/wire/protocol";
import type { SessionEntry } from "./session-entry";

type PromptCacheMethod = (entry: SessionEntry, args: unknown[]) => Promise<unknown>;

/** The status as JSON-safe data: fields the SDK leaves undefined are omitted, never sent as null. */
function statusDto(status: PromptCacheStatus): PromptCacheStatusDto {
	return {
		state: status.state,
		...(status.reason === undefined ? {} : { reason: { ...status.reason } }),
		inferred: status.inferred,
		tier: status.tier,
		touchedAt: status.touchedAt,
		...(status.ttlMs === undefined ? {} : { ttlMs: status.ttlMs }),
		cachedTokens: status.cachedTokens,
		nextTokens: status.nextTokens,
		...(status.warming === undefined ? {} : { warming: { ...status.warming } }),
	};
}

/** The session's prompt-cache status with its SDK-worded brief and detail rows; `{ status: null }` when there is nothing to report. */
export function promptCacheReply(
	session: AgentSession,
	nowMs = Date.now(),
): PromptCacheStatusReply {
	const status = session.getPromptCacheStatus(nowMs);
	if (status === undefined) return { status: null };
	const [head, next] = promptCacheBrief(status, nowMs);
	return {
		status: statusDto(status),
		brief: [head, next],
		details: promptCacheDetails(status, nowMs).map((row) => ({
			label: row.label,
			value: row.value,
			...(row.tone === undefined ? {} : { tone: row.tone }),
		})),
	};
}

export function createPromptCacheMethods(): Record<string, PromptCacheMethod> {
	return {
		getPromptCacheStatus: async (entry) => promptCacheReply(entry.session, Date.now()),
	};
}
