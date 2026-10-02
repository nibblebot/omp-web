import {
	setExcludedSearchProviders,
	setSearchProviderOrder,
} from "@oh-my-pi/pi-coding-agent/web/search/provider";
import { isSearchProviderId } from "@oh-my-pi/pi-coding-agent/web/search/types";
import { setImageProviderOrder } from "@oh-my-pi/pi-coding-agent/tools/image-gen";

/** Structural slice of AgentSession this module calls (kept narrow for testability). */
export interface AgentSessionLike {
	setSteeringMode(mode: "all" | "one-at-a-time"): void;
	setFollowUpMode(mode: "all" | "one-at-a-time"): void;
	setInterruptMode(mode: "immediate" | "wait"): void;
	setAdvisorEnabled(enabled: boolean): void;
	setThinkingLevel(level: never, persist?: boolean): void;
	refreshBaseSystemPrompt(): Promise<void>;
	applyMemoryBackend(): Promise<void>;
	agent: {
		temperature?: number;
		topP?: number;
		topK?: number;
		minP?: number;
		presencePenalty?: number;
		repetitionPenalty?: number;
		hideThinkingSummary?: boolean;
	};
}

/**
 * Web-relevant subset of the TUI's handleSettingChange: session setters and
 * runtime preference updates. settings.set() (persist) already ran in the
 * caller for schema paths; this switch only applies live side effects, so
 * TUI-only rendering side effects are skipped and unknown paths are rejected
 * upstream by coerceSettingValue.
 */
export async function applySettingSideEffects(
	session: AgentSessionLike,
	path: string,
	value: unknown,
): Promise<void> {
	switch (path) {
		case "steeringMode":
			session.setSteeringMode(value as "all" | "one-at-a-time");
			break;
		case "followUpMode":
			session.setFollowUpMode(value as "all" | "one-at-a-time");
			break;
		case "interruptMode":
			session.setInterruptMode(value as "immediate" | "wait");
			break;
		case "advisor.enabled":
			session.setAdvisorEnabled(value === true);
			break;
		case "defaultThinkingLevel":
			session.setThinkingLevel(value as never, true);
			break;
		case "personality":
		case "tools.xdevDocs":
			await session.refreshBaseSystemPrompt();
			break;
		case "memory.backend":
			await session.applyMemoryBackend();
			break;
		case "temperature":
		case "topP":
		case "topK":
		case "minP":
		case "presencePenalty":
		case "repetitionPenalty": {
			const n = Number(value);
			session.agent[path] = n >= 0 ? n : undefined;
			break;
		}
		case "omitThinking":
			session.agent.hideThinkingSummary = value === true;
			break;
		case "providers.webSearchOrder":
			if (Array.isArray(value)) setSearchProviderOrder(value.filter(isSearchProviderId));
			break;
		case "providers.webSearchExclude":
			if (Array.isArray(value)) setExcludedSearchProviders(value.filter(isSearchProviderId));
			break;
		case "providers.imageOrder":
			if (Array.isArray(value)) setImageProviderOrder(value.filter((v) => typeof v === "string"));
			break;
		// All other schema paths: persist-only (settings.set already applied).
	}
}
