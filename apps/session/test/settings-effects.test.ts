import { describe, expect, test } from "bun:test";
import { applySettingSideEffects, type AgentSessionLike } from "../settings-effects";

describe("applySettingSideEffects", () => {
	test("applies session setters and runtime agent fields", async () => {
		const calls: string[] = [];
		const agent: AgentSessionLike["agent"] = {};
		const session: AgentSessionLike = {
			setSteeringMode: (mode) => void calls.push(`steering:${mode}`),
			setFollowUpMode: (mode) => void calls.push(`followUp:${mode}`),
			setInterruptMode: (mode) => void calls.push(`interrupt:${mode}`),
			setAdvisorEnabled: (enabled) => void calls.push(`advisor:${enabled}`),
			setThinkingLevel: (level, persist) =>
				void calls.push(`thinking:${String(level)}:${persist === true}`),
			refreshBaseSystemPrompt: async () => void calls.push("refreshPrompt"),
			applyMemoryBackend: async () => void calls.push("applyMemory"),
			agent,
		};

		await applySettingSideEffects(session, "steeringMode", "all");
		await applySettingSideEffects(session, "defaultThinkingLevel", "high");
		await applySettingSideEffects(session, "personality", "friendly");
		await applySettingSideEffects(session, "temperature", "1.5");
		await applySettingSideEffects(session, "omitThinking", true);
		await applySettingSideEffects(session, "memory.backend", "local");
		// Persist-only paths have no side effect.
		await applySettingSideEffects(session, "compaction.enabled", true);

		expect(calls).toEqual(["steering:all", "thinking:high:true", "refreshPrompt", "applyMemory"]);
		expect(agent.temperature).toBe(1.5);
		expect(agent.hideThinkingSummary).toBe(true);

		await applySettingSideEffects(session, "temperature", -1);
		expect(agent.temperature).toBeUndefined();
	});
});
