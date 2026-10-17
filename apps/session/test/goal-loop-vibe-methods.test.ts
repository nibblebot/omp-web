/**
 * Arg-shape pins for the goal, loop, and vibe rows of the web methods table
 * (apps/session/methods.ts). Each consent gate runs before any session or
 * adapter access, so a stub entry is enough to assert the wire contract the
 * Goal dialog depends on: object-form goal input carries its objective and
 * consent, and every consent-gated call refuses when consent is absent.
 */

import { describe, expect, test } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent";
import { createWebMethods } from "../methods";
import type { SessionEntry } from "../session-entry";

function stubEntry(): SessionEntry {
	const session = { settings: Settings.isolated() };
	return { session } as unknown as SessionEntry;
}

function methodsTable() {
	return createWebMethods({
		settings: {} as never,
		authStorage: {} as never,
		collab: {} as never,
		broker: {} as never,
		materializeSession: async () => ({ alreadyPresent: true as const }),
		sessionsDir: "/tmp/goal-loop-vibe-test-sessions",
		cwd: "/tmp/goal-loop-vibe-test-cwd",
		hasCallbackPair: () => false,
	}).methods;
}

describe("goal rows: object-form input carries objective and consent", () => {
	test("goalCreate object form without consent is refused", async () => {
		const methods = methodsTable();
		await expect(
			methods.goalCreate!(stubEntry(), [{ objective: "Ship the export", tokenBudget: 5_000 }]),
		).rejects.toThrow("Explicit goal execution consent is required");
	});

	test("goalCreate object form with consent false is refused", async () => {
		const methods = methodsTable();
		await expect(
			methods.goalCreate!(stubEntry(), [{ objective: "Ship the export", consent: false }]),
		).rejects.toThrow("Explicit goal execution consent is required");
	});

	test("goalReplace without consent is refused", async () => {
		const methods = methodsTable();
		await expect(
			methods.goalReplace!(stubEntry(), ["Replacement objective", { tokenBudget: 1_000 }]),
		).rejects.toThrow("Explicit goal execution consent is required");
	});

	test("goalResume without consent is refused", async () => {
		const methods = methodsTable();
		await expect(methods.goalResume!(stubEntry(), [{}])).rejects.toThrow(
			"Explicit goal resume consent is required",
		);
	});
});

describe("vibe rows: consent is required before work starts", () => {
	test("vibeSetMode enabling without consent is refused", async () => {
		const methods = methodsTable();
		await expect(methods.vibeSetMode!(stubEntry(), [true])).rejects.toThrow(
			"Vibe director start requires explicit consent",
		);
	});

	test("vibeSpawn without consent is refused", async () => {
		const methods = methodsTable();
		await expect(
			methods.vibeSpawn!(stubEntry(), [{ cli: "fast", prompt: "Audit the API" }]),
		).rejects.toThrow("Vibe worker spawn requires explicit consent");
	});

	test("vibeSend without consent is refused", async () => {
		const methods = methodsTable();
		await expect(
			methods.vibeSend!(stubEntry(), [{ session: "vibe_a1", message: "status?" }]),
		).rejects.toThrow("Vibe worker send requires explicit consent");
	});
});
