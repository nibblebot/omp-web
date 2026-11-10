/**
 * Ask re-answer through the session tree: `navigateTree` probes an `ask` result and answers
 * `reopenAsk { toolCallId, html }`; `reanswerAsk` then runs the SDK's real AskTool against that
 * html through the session's UI context and navigates with the tool's own result. The session
 * is a fake with the SDK's navigate contract; the form is answered by a fake UI context.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent";
import type { ExtensionUIContext } from "@oh-my-pi/pi-coding-agent";
import type { SessionEntry as SdkEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { createGraphModelHandlers } from "../graph-model-adapter";
import { initSdkTuiGlobals } from "../sdk-tui-globals";
import type { SessionEntry } from "../session-entry";

const originalNotifications = process.env.PI_NOTIFICATIONS;
beforeAll(initSdkTuiGlobals);
afterAll(() => {
	if (originalNotifications === undefined) delete process.env.PI_NOTIFICATIONS;
	else process.env.PI_NOTIFICATIONS = originalNotifications;
});

const FORM = `<form>
  <fieldset>
    <legend>Which store?</legend>
    <label><input type="radio" name="store" value="sqlite" checked> SQLite</label>
    <label><input type="radio" name="store" value="redis"> Redis</label>
  </fieldset>
</form>`;

type Answer = { data: Record<string, string | number | string[]>; timedOut?: boolean } | undefined;

function setup(answer: () => Promise<Answer> | Answer) {
	const entries = [
		{
			type: "message",
			id: "u1",
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			message: { role: "user", content: "pick a store" },
		},
		{
			type: "message",
			id: "ask1",
			parentId: "u1",
			timestamp: "2026-01-01T00:00:01.000Z",
			message: {
				role: "toolResult",
				toolName: "ask",
				toolCallId: "call-1",
				content: [{ type: "text", text: "old answer" }],
			},
		},
		{
			type: "message",
			id: "u2",
			parentId: "ask1",
			timestamp: "2026-01-01T00:00:02.000Z",
			message: { role: "user", content: "go on" },
		},
	] as unknown as SdkEntry[];
	let leafId = "u2";
	const navigations: Array<{ targetId: string; options: Record<string, unknown> }> = [];
	const log: string[] = [];
	const formHtml: string[] = [];
	const session = {
		sessionId: "sess-1",
		settings: Settings.isolated({}),
		sessionManager: {
			getEntries: () => entries,
			getEntry: (id: string) => entries.find((e) => e.id === id),
			getLeafId: () => leafId,
			getCwd: () => process.cwd(),
			getSessionFile: () => undefined,
			getLabel: () => undefined,
			getHeader: () => undefined,
		},
		getPlanModeState: () => undefined,
		buildAskReanswerContext: (ui: ExtensionUIContext) => ({
			ui,
			hasUI: true,
			abort: () => log.push("abort"),
		}),
		navigateTree: async (targetId: string, options: Record<string, unknown>) => {
			navigations.push({ targetId, options });
			if (options.reanswerAskResult === undefined) {
				return { cancelled: false, reopenAsk: { toolCallId: "call-1", html: FORM } };
			}
			leafId = "new-ask";
			return { cancelled: false, askReanswerCommitted: true };
		},
		resumeAfterAskReanswer: () => log.push("resume"),
	};
	const entry = { handle: "s1", session } as unknown as SessionEntry;
	const uiContext = {
		formDialog: async (html: string) => {
			formHtml.push(html);
			return answer();
		},
	} as unknown as ExtensionUIContext;
	const handlers = createGraphModelHandlers({
		rebuildTranscript: async () => {
			log.push("rebuild");
		},
		uiContext: () => uiContext,
	});
	const revision = async () => {
		const page = handlers.getSessionGraph(entry);
		return page.revision;
	};
	return {
		handlers,
		entry,
		revision,
		navigations,
		log,
		formHtml,
		moveLeaf: (id: string) => {
			leafId = id;
		},
	};
}

describe("ask re-answer", () => {
	test("probes, runs the SDK AskTool on the probed form, and navigates with its result", async () => {
		const t = setup(() => ({ data: { store: "redis" } }));
		const probe = await t.handlers.navigateTree(t.entry, "ask1", {
			revision: await t.revision(),
			allowAskReopen: true,
		});
		expect(probe.reopenAsk).toEqual({ toolCallId: "call-1", html: FORM });
		expect(t.log).toEqual([]);

		const done = await t.handlers.reanswerAsk(t.entry, "ask1", { revision: probe.revision });

		expect(t.formHtml).toEqual([FORM]);
		expect(t.navigations).toHaveLength(2);
		const second = t.navigations[1]!;
		expect(second.targetId).toBe("ask1");
		expect(second.options.allowAskReopen).toBe(true);
		expect(second.options.reanswerAskResult).toEqual({
			content: [
				{ type: "text", text: `User answers:\n${JSON.stringify({ store: "redis" }, null, 2)}` },
			],
			details: { answers: [{ name: "store", question: "Which store?", answer: "Redis" }] },
		});
		expect(done.askReanswerCommitted).toBe(true);
		expect(t.log).toEqual(["rebuild"]);

		t.handlers.resumeAfterAskReanswer(t.entry);
		expect(t.log).toEqual(["rebuild", "resume"]);
	});

	test("a cancelled question navigates nowhere", async () => {
		const t = setup(() => undefined);
		const probe = await t.handlers.navigateTree(t.entry, "ask1", {
			revision: await t.revision(),
			allowAskReopen: true,
		});
		const done = await t.handlers.reanswerAsk(t.entry, "ask1", { revision: probe.revision });
		expect(done.cancelled).toBe(true);
		expect(t.navigations).toHaveLength(1);
		expect(t.log).toEqual(["abort"]);
	});

	test("refuses without a probe for that target", async () => {
		const t = setup(() => ({ data: { store: "redis" } }));
		const revision = await t.revision();
		await expect(t.handlers.reanswerAsk(t.entry, "ask1", { revision })).rejects.toThrow(
			"no current probe",
		);
		await t.handlers.navigateTree(t.entry, "ask1", { revision, allowAskReopen: true });
		await expect(t.handlers.reanswerAsk(t.entry, "u1", { revision })).rejects.toThrow(
			"no current probe",
		);
		expect(t.formHtml).toEqual([]);
	});

	test("refuses a stale revision and a probe that was already spent", async () => {
		const t = setup(() => ({ data: { store: "redis" } }));
		const revision = await t.revision();
		await t.handlers.navigateTree(t.entry, "ask1", { revision, allowAskReopen: true });
		await expect(
			t.handlers.reanswerAsk(t.entry, "ask1", { revision: "not-current" }),
		).rejects.toThrow("stale");
		await t.handlers.reanswerAsk(t.entry, "ask1", { revision });
		const next = await t.revision();
		await expect(t.handlers.reanswerAsk(t.entry, "ask1", { revision: next })).rejects.toThrow(
			"no current probe",
		);
		expect(t.formHtml).toHaveLength(1);
	});

	test("refuses when the session moved while the question was open", async () => {
		let t!: ReturnType<typeof setup>;
		t = setup(() => {
			t.moveLeaf("u1");
			return { data: { store: "redis" } };
		});
		const revision = await t.revision();
		await t.handlers.navigateTree(t.entry, "ask1", { revision, allowAskReopen: true });
		await expect(t.handlers.reanswerAsk(t.entry, "ask1", { revision })).rejects.toThrow(
			"Session changed",
		);
		expect(t.navigations).toHaveLength(1);
	});

	test("navigateTree no longer takes a client-built answer", async () => {
		const t = setup(() => ({ data: {} }));
		await expect(
			t.handlers.navigateTree(t.entry, "ask1", {
				revision: await t.revision(),
				allowAskReopen: true,
				reanswerAskResult: { content: [], details: { answers: [] } },
			} as never),
		).rejects.toThrow("use reanswerAsk");
		expect(t.navigations).toHaveLength(0);
	});
});
