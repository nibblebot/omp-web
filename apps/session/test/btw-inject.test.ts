/**
 * /btw steering inject (SDK 18.16.0 `btw.inject`): a side answer's `<inject>` block can be sent
 * to the main session once, only when the answer was asked in this run with the setting on, and a
 * refused send leaves it pending for a retry. Real BtwHistoryStore on a temp dir and the real
 * Settings; only the session is faked.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { BtwHistoryStore } from "@oh-my-pi/pi-coding-agent/session/btw-history";
import { cleanupTempDirs, tempDir } from "#lib/testkit/temp-dir.testkit";
import { serviceFor, type BtwRecordDto } from "../btw-history-adapter";

afterAll(cleanupTempDirs);

const BLOCK = "Pause the refactor and fix the failing build first.";
const WITH_BLOCK = `Send this:\n\n<inject>\n  ${BLOCK}\n</inject>\n\nIt unblocks CI.`;

interface PromptCall {
	text: string;
	options: Record<string, unknown>;
}

type PromptBehavior = (
	call: PromptCall,
	hooks: { admit: () => void; queue: () => void },
) => Promise<boolean>;

interface Fixture {
	session: AgentSession;
	asked: Array<{ promptText: string }>;
	prompts: PromptCall[];
	/** The answer the next side turn gives. */
	reply: { text: string };
	behave: { prompt: PromptBehavior };
}

let nextId = 0;

/** A session whose side turns answer `reply.text` and whose prompt follows `behave.prompt`. */
async function openFixture(
	settings: Record<string, unknown> = { "btw.inject": true },
): Promise<Fixture> {
	const sessionId = `sess-btw-inject-${nextId++}`;
	const artifactsDir = tempDir("omp-btw-inject-");
	// Opening the scope up front keeps the service from creating it lazily mid-test.
	await (await BtwHistoryStore.open(artifactsDir, sessionId)).flush();
	const asked: Fixture["asked"] = [];
	const prompts: PromptCall[] = [];
	const reply = { text: WITH_BLOCK };
	const behave: Fixture["behave"] = {
		prompt: async (_call, hooks) => {
			hooks.admit();
			return true;
		},
	};
	const session = {
		model: { api: "test-api", provider: "test", id: "test-model" },
		settings: Settings.isolated(settings),
		messages: [],
		hasPendingDeferredExtensions: false,
		sessionManager: {
			getSessionId: () => sessionId,
			getLeafId: () => "leaf-1",
			getArtifactsDir: () => artifactsDir,
			ensureOnDisk: async () => {},
		},
		runEphemeralTurn: async (args: { promptText: string }) => {
			asked.push(args);
			return {
				replyText: reply.text,
				assistantMessage: { role: "assistant", content: [{ type: "text", text: reply.text }] },
			};
		},
		prompt: (text: string, options: Record<string, unknown>) => {
			const call = { text, options };
			prompts.push(call);
			return behave.prompt(call, {
				admit: () => (options.onPromptAdmitted as () => void)(),
				queue: () => (options.onPromptQueued as () => void)(),
			});
		},
	} as unknown as AgentSession;
	return { session, asked, prompts, reply, behave };
}

async function ask(fixture: Fixture, recordId?: string): Promise<BtwRecordDto> {
	const service = await serviceFor(fixture.session);
	return service.startBtwTurn(fixture.session, "write the steering prompt", { recordId });
}

describe("asking with btw.inject", () => {
	test("the instruction rides the side prompt only while the setting is on", async () => {
		const on = await openFixture({ "btw.inject": true });
		await ask(on);
		expect(on.asked[0]!.promptText).toContain("<inject>");
		const off = await openFixture({ "btw.inject": false });
		await ask(off);
		expect(off.asked[0]!.promptText).not.toContain("<inject>");
	});

	test("a closed block makes the answer's turn pending; no block, an unclosed block, or the setting off leave it plain", async () => {
		const fixture = await openFixture();
		expect((await ask(fixture)).inject).toBe("pending");
		fixture.reply.text = "No steering needed here.";
		expect((await ask(fixture)).inject).toBeUndefined();
		fixture.reply.text = "<inject>never closed";
		expect((await ask(fixture)).inject).toBeUndefined();
		const off = await openFixture({ "btw.inject": false });
		expect((await ask(off)).inject).toBeUndefined();
	});

	test("the saved list and the paged thread report the state", async () => {
		const fixture = await openFixture();
		const { id } = await ask(fixture);
		const service = await serviceFor(fixture.session);
		expect(service.listBtwRecords().records[0]).toMatchObject({ id, inject: "pending" });
		expect(service.pageBtwTurns(id).turns[0]).toMatchObject({ index: 0, inject: "pending" });
	});

	test("an answer saved by an earlier run has no state and cannot send", async () => {
		const fixture = await openFixture();
		const store = await BtwHistoryStore.open(
			fixture.session.sessionManager.getArtifactsDir()!,
			fixture.session.sessionManager.getSessionId(),
		);
		await store.upsert({
			id: "rec-earlier-run",
			leafId: "leaf-1",
			question: "q",
			answer: WITH_BLOCK,
			status: "complete",
			createdAt: 1,
			updatedAt: 2,
		});
		await store.flush();
		const service = await serviceFor(fixture.session);
		const record = service.listBtwRecords().records.find((r) => r.id === "rec-earlier-run")!;
		expect(record.inject).toBeUndefined();
		await expect(service.injectBtw(fixture.session, "rec-earlier-run")).rejects.toThrow(
			"no steering prompt to send",
		);
		expect(fixture.prompts).toEqual([]);
	});
});

describe("injectBtw", () => {
	test("sends the block exactly as shown, as a steer while running, without expanding commands", async () => {
		const fixture = await openFixture();
		const { id } = await ask(fixture);
		const service = await serviceFor(fixture.session);
		const result = await service.injectBtw(fixture.session, id);
		expect(fixture.prompts).toHaveLength(1);
		expect(fixture.prompts[0]!.text).toBe(BLOCK);
		expect(fixture.prompts[0]!.options).toMatchObject({
			expandPromptTemplates: false,
			streamingBehavior: "steer",
			throwOnDrop: true,
		});
		expect(result.inject).toBe("sent");
		expect(service.listBtwRecords().records[0]!.inject).toBe("sent");
		expect(service.pageBtwTurns(id).turns[0]!.inject).toBe("sent");
	});

	test("an answer sends once: a repeat is refused and the main session sees one prompt", async () => {
		const fixture = await openFixture();
		const { id } = await ask(fixture);
		const service = await serviceFor(fixture.session);
		await service.injectBtw(fixture.session, id);
		await expect(service.injectBtw(fixture.session, id)).rejects.toThrow("already sent");
		expect(fixture.prompts).toHaveLength(1);
	});

	test("a send in flight shows as sending and refuses a second send", async () => {
		const fixture = await openFixture();
		const { id } = await ask(fixture);
		const service = await serviceFor(fixture.session);
		const gate = Promise.withResolvers<void>();
		const started = Promise.withResolvers<void>();
		fixture.behave.prompt = async (_call, hooks) => {
			started.resolve();
			await gate.promise;
			hooks.admit();
			return true;
		};
		const first = service.injectBtw(fixture.session, id);
		await started.promise;
		expect(service.listBtwRecords().records[0]!.inject).toBe("sending");
		await expect(service.injectBtw(fixture.session, id)).rejects.toThrow("still sending");
		// Branching rewrites the main session: it waits for the send.
		expect(
			(await service.previewPromoteBtw(fixture.session, fixture.session.sessionManager, id)).reason,
		).toBe("a /btw prompt is still sending");
		gate.resolve();
		expect((await first).inject).toBe("sent");
		expect(fixture.prompts).toHaveLength(1);
	});

	test("a prompt the session refuses leaves the block pending, and the same call retries", async () => {
		const fixture = await openFixture();
		const { id } = await ask(fixture);
		const service = await serviceFor(fixture.session);
		fixture.behave.prompt = async () => {
			throw new Error("Prompt dropped before provider dispatch.");
		};
		await expect(service.injectBtw(fixture.session, id)).rejects.toThrow(
			"dropped before provider dispatch",
		);
		expect(service.listBtwRecords().records[0]!.inject).toBe("pending");
		fixture.behave.prompt = async (_call, hooks) => {
			hooks.admit();
			return true;
		};
		expect((await service.injectBtw(fixture.session, id)).inject).toBe("sent");
		expect(fixture.prompts).toHaveLength(2);
	});

	test("a prompt dropped while queueing (resolved, never admitted) is not sent", async () => {
		const fixture = await openFixture();
		const { id } = await ask(fixture);
		const service = await serviceFor(fixture.session);
		fixture.behave.prompt = async () => true;
		await expect(service.injectBtw(fixture.session, id)).rejects.toThrow("not sent");
		expect(service.listBtwRecords().records[0]!.inject).toBe("pending");
	});

	test("a failure after admission keeps it sent and is reported, never retried", async () => {
		const fixture = await openFixture();
		const { id } = await ask(fixture);
		const service = await serviceFor(fixture.session);
		fixture.behave.prompt = async (_call, hooks) => {
			hooks.admit();
			throw new Error("the turn it started failed");
		};
		const late = Promise.withResolvers<unknown>();
		const result = await service.injectBtw(fixture.session, id, { onLateError: late.resolve });
		expect(result.inject).toBe("sent");
		expect(String(await late.promise)).toBe("Error: the turn it started failed");
		await expect(service.injectBtw(fixture.session, id)).rejects.toThrow("already sent");
	});

	test("a prompt already queued when it errors counts as sent", async () => {
		const fixture = await openFixture();
		const { id } = await ask(fixture);
		const service = await serviceFor(fixture.session);
		fixture.behave.prompt = async (_call, hooks) => {
			hooks.queue();
			throw new Error("steer queue closed");
		};
		const late = Promise.withResolvers<unknown>();
		const result = await service.injectBtw(fixture.session, id, { onLateError: late.resolve });
		expect(result.inject).toBe("sent");
		// Reported once the prompt settles; the mark stays.
		expect(String(await late.promise)).toBe("Error: steer queue closed");
		expect((await service.listBtwRecords()).records[0]!.inject).toBe("sent");
	});

	test("a follow-up starts a fresh answer: the sent turn stays sent and the new block is pending", async () => {
		const fixture = await openFixture();
		const first = await ask(fixture);
		const service = await serviceFor(fixture.session);
		await service.injectBtw(fixture.session, first.id);
		const followed = await ask(fixture, first.id);
		expect(followed.inject).toBe("sent");
		expect(followed.followUps![0]!.inject).toBe("pending");
		expect((await service.injectBtw(fixture.session, first.id)).followUps![0]!.inject).toBe("sent");
		expect(fixture.prompts).toHaveLength(2);
	});

	test("a turn replaced by a follow-up before it was sent stops being sendable", async () => {
		const fixture = await openFixture();
		const first = await ask(fixture);
		const followed = await ask(fixture, first.id);
		expect(followed.inject).toBeUndefined();
		expect(followed.followUps![0]!.inject).toBe("pending");
	});

	test("an unknown record is refused", async () => {
		const fixture = await openFixture();
		await ask(fixture);
		const service = await serviceFor(fixture.session);
		await expect(service.injectBtw(fixture.session, "nope")).rejects.toThrow(
			"BTW record not found",
		);
	});
});
