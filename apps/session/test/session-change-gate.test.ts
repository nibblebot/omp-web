import { describe, expect, test } from "bun:test";
import { SESSION_REPLACING_METHODS } from "#lib/wire/protocol";
import { createSessionChangeGate, SESSION_CHANGE_IN_PROGRESS } from "../session-change-gate";

const SEND: Record<string, true> = { prompt: true, steer: true, followUp: true };

describe("session change gate", () => {
	test("a prompt that arrives while newSession runs is refused, then accepted once it finishes", async () => {
		const gate = createSessionChangeGate(SEND);
		const change = Promise.withResolvers<{ cancelled: boolean }>();
		const running = gate.track("newSession", () => change.promise);

		// The SDK has minted the new id but nobody has been told: a send now would
		// run on the old session or be refused as stale. It is refused by name.
		expect(() => gate.assertOpen("prompt")).toThrow(SESSION_CHANGE_IN_PROGRESS);
		expect(() => gate.assertOpen("steer")).toThrow(SESSION_CHANGE_IN_PROGRESS);

		change.resolve({ cancelled: false });
		expect(await running).toEqual({ cancelled: false });
		expect(() => gate.assertOpen("prompt")).not.toThrow();
	});

	test("calls that do not send into the session pass during a change", async () => {
		const gate = createSessionChangeGate(SEND);
		const change = Promise.withResolvers<void>();
		const running = gate.track("newSession", () => change.promise);
		expect(() => gate.assertOpen("getSubagents")).not.toThrow();
		expect(() => gate.assertOpen("abort")).not.toThrow();
		change.resolve();
		await running;
	});

	test.each([...SESSION_REPLACING_METHODS])("%s closes the gate", async (method) => {
		const gate = createSessionChangeGate(SEND);
		const change = Promise.withResolvers<void>();
		const running = gate.track(method, () => change.promise);
		expect(() => gate.assertOpen("prompt")).toThrow(SESSION_CHANGE_IN_PROGRESS);
		change.resolve();
		await running;
		expect(() => gate.assertOpen("prompt")).not.toThrow();
	});

	test("an ordinary call never closes the gate", async () => {
		const gate = createSessionChangeGate(SEND);
		const slow = Promise.withResolvers<void>();
		const running = gate.track("setModel", () => slow.promise);
		expect(() => gate.assertOpen("prompt")).not.toThrow();
		slow.resolve();
		await running;
	});

	test("a failed change reopens the gate and rethrows", async () => {
		const gate = createSessionChangeGate(SEND);
		const refused = gate.track("newSession", async () => {
			throw new Error("Another session lifecycle operation is in progress");
		});
		await expect(refused).rejects.toThrow("Another session lifecycle operation is in progress");
		expect(() => gate.assertOpen("prompt")).not.toThrow();
	});

	test("the gate stays closed until every overlapping change has finished", async () => {
		const gate = createSessionChangeGate(SEND);
		const first = Promise.withResolvers<void>();
		const second = Promise.withResolvers<void>();
		const a = gate.track("newSession", () => first.promise);
		const b = gate.track("switchSession", () => second.promise);
		first.resolve();
		await a;
		expect(() => gate.assertOpen("prompt")).toThrow(SESSION_CHANGE_IN_PROGRESS);
		second.resolve();
		await b;
		expect(() => gate.assertOpen("prompt")).not.toThrow();
	});
});
