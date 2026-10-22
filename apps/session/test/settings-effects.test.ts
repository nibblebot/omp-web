import { describe, expect, test } from "bun:test";
import { applySettingSideEffects } from "../settings-effects";

function fakeSession() {
	const calls: string[] = [];
	return {
		calls,
		session: {
			settleMemoryBackend: async () => {
				calls.push("settleMemoryBackend");
			},
		},
	};
}

describe("applySettingSideEffects", () => {
	test("a memory backend edit waits for the SDK-owned transition", async () => {
		const { calls, session } = fakeSession();
		await applySettingSideEffects(session, "memory.backend");
		expect(calls).toEqual(["settleMemoryBackend"]);
	});

	test("a default thinking level edit leaves the attached session alone", async () => {
		const { calls, session } = fakeSession();
		await applySettingSideEffects(session, "defaultThinkingLevel");
		expect(calls).toEqual([]);
	});

	test("an unrelated edit has no side effect", async () => {
		const { calls, session } = fakeSession();
		await applySettingSideEffects(session, "steeringMode");
		expect(calls).toEqual([]);
	});
});
