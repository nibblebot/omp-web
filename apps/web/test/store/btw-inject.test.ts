import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ClientCommand } from "#lib/wire/protocol";
import { connect } from "../../state";
import {
	btwHistoryRecords,
	btwInjectFailure,
	btwInjectKey,
	btwInjecting,
	btwTranscript,
	closeBtwHistory,
	injectBtw,
	refreshBtwHistory,
	selectBtwRecord,
	syncTranscriptInject,
	type BtwRecordView,
	type BtwTranscriptTurnView,
} from "../../store/btw-history";
import {
	FakeWebSocket,
	attached,
	callResult,
	dispatch,
	flushMicrotasks,
	installTransportStubs,
	posted,
	restoreBrowserGlobals,
} from "../web.testkit";

type Call = Extract<ClientCommand, { type: "call" }>;

const ANSWER = "Send this:\n<inject>Fix the build first.</inject>";

function record(inject: BtwRecordView["inject"]): Record<string, unknown> {
	return {
		id: "r1",
		leafId: "leaf-1",
		question: "write the steering prompt",
		answer: ANSWER,
		status: "complete",
		createdAt: 1,
		updatedAt: 2,
		...(inject ? { inject } : {}),
	};
}

function callsOf(method: string): Call[] {
	return posted.filter((cmd): cmd is Call => cmd.type === "call" && cmd.method === method);
}

/** Answer the newest unanswered call of `method` with data, or fail it with `error`. */
async function answer(method: string, data: unknown, error?: string): Promise<void> {
	const pending = callsOf(method).at(-1)!;
	dispatch(callResult(pending.id, data, error === undefined, error));
	await flushMicrotasks();
}

/** The saved list and the open thread, as the sheet has them after selecting the record. */
async function openThread(inject: BtwRecordView["inject"]): Promise<void> {
	refreshBtwHistory();
	await answer("btwList", { records: [record(inject)], total: 1 });
	selectBtwRecord("r1");
	await answer("btwPage", {
		turns: [{ key: "r1:t0", index: 0, ...record(inject) }],
		total: 1,
	});
}

function openTurn(): BtwTranscriptTurnView {
	return btwTranscript().turns[0]!;
}

beforeEach(() => {
	installTransportStubs();
	connect();
	FakeWebSocket.instances.at(-1)!.onopen?.();
	dispatch(attached("session-a"));
});

afterEach(() => {
	closeBtwHistory();
	restoreBrowserGlobals();
});

describe("injectBtw", () => {
	test("sends the record id, marks the turn sending, then sent from the session's answer", async () => {
		await openThread("pending");
		expect(openTurn().inject).toBe("pending");
		const sending = injectBtw("r1");
		expect(callsOf("btwInject").map((cmd) => cmd.args)).toEqual([["r1"]]);
		expect(btwInjecting().has(btwInjectKey("r1", 0))).toBe(true);
		await answer("btwInject", { record: record("sent") });
		expect(await sending).toBe(true);
		expect(btwInjecting().size).toBe(0);
		expect(openTurn().inject).toBe("sent");
		expect(btwHistoryRecords()[0]!.inject).toBe("sent");
		expect(btwInjectFailure()).toBeNull();
	});

	test("a second send while one is in flight is ignored", async () => {
		await openThread("pending");
		const first = injectBtw("r1");
		expect(await injectBtw("r1")).toBe(false);
		expect(callsOf("btwInject")).toHaveLength(1);
		await answer("btwInject", { record: record("sent") });
		await first;
	});

	test("a refusal keeps the turn pending with the reason, and the same action retries", async () => {
		await openThread("pending");
		const refused = injectBtw("r1");
		await answer("btwInject", undefined, "Prompt dropped before provider dispatch.");
		expect(await refused).toBe(false);
		expect(openTurn().inject).toBe("pending");
		expect(btwInjectFailure()).toEqual({
			key: btwInjectKey("r1", 0),
			message: "Prompt dropped before provider dispatch.",
		});
		expect(btwInjecting().size).toBe(0);
		// The failure re-reads the session's own view.
		expect(callsOf("btwList")).toHaveLength(2);

		const retry = injectBtw("r1");
		expect(btwInjectFailure()).toBeNull();
		expect(callsOf("btwInject")).toHaveLength(2);
		await answer("btwInject", { record: record("sent") });
		expect(await retry).toBe(true);
		expect(openTurn().inject).toBe("sent");
	});

	test("a send another page already made reads as sent once the list refreshes", async () => {
		await openThread("pending");
		const lost = injectBtw("r1");
		await answer(
			"btwInject",
			undefined,
			"This steering prompt was already sent to the main session.",
		);
		expect(await lost).toBe(false);
		// The refresh the refusal triggered brings the session's state.
		await answer("btwList", { records: [record("sent")], total: 1 });
		expect(openTurn().inject).toBe("sent");
	});
});

describe("record payloads", () => {
	test("an unknown inject value from the session is ignored rather than shown", async () => {
		await openThread(undefined);
		expect(openTurn().inject).toBeUndefined();
		refreshBtwHistory();
		await answer("btwList", { records: [{ ...record(undefined), inject: "bogus" }], total: 1 });
		expect(btwHistoryRecords()[0]!.inject).toBeUndefined();
	});
});

describe("syncTranscriptInject", () => {
	const turn = (
		index: number,
		inject?: BtwTranscriptTurnView["inject"],
	): BtwTranscriptTurnView => ({
		key: `r1:t${index}`,
		index,
		question: "q",
		answer: "a",
		status: "complete",
		createdAt: 0,
		updatedAt: 0,
		...(inject ? { inject } : {}),
	});
	const thread = { recordId: "r1", turns: [turn(0, "sent"), turn(1, "pending")] };
	const fresh = (second: BtwRecordView["inject"]): BtwRecordView => ({
		id: "r1",
		leafId: null,
		question: "q",
		answer: "a",
		status: "complete",
		createdAt: 0,
		updatedAt: 0,
		inject: "sent",
		followUps: [
			{
				question: "q",
				answer: "a",
				status: "complete",
				createdAt: 0,
				updatedAt: 0,
				inject: second,
			},
		],
	});

	test("turn 0 reads the record's own state and turn i+1 reads followUps[i]", () => {
		const synced = syncTranscriptInject(thread, fresh("sent"));
		expect(synced.turns.map((t) => t.inject)).toEqual(["sent", "sent"]);
	});

	test("a state the session dropped is dropped from the turn", () => {
		const synced = syncTranscriptInject(thread, fresh(undefined));
		expect(synced.turns[1]).not.toHaveProperty("inject");
	});

	test("nothing moved: the same thread comes back; another record's thread is untouched", () => {
		expect(syncTranscriptInject(thread, fresh("pending"))).toBe(thread);
		expect(syncTranscriptInject({ ...thread, recordId: "r2" }, fresh("sent")).turns).toBe(
			thread.turns,
		);
	});
});
