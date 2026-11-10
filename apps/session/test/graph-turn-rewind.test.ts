/**
 * A transcript turn's Edit & resend / Retry (`rewindTurn`) and the rewind picker's lookup
 * (`findTurnEntry`): the browser names a turn by role and message timestamp, as the SDK's
 * `runTurnAction` does, and the session resolves it on the current branch. The session is a
 * fake with the SDK's navigate contract.
 */
import { describe, expect, test } from "bun:test";
import type { SessionEntry as SdkEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { createGraphModelHandlers } from "../graph-model-adapter";
import { createWebMethods } from "../methods";
import type { SessionEntry } from "../session-entry";

function message(id: string, parentId: string | null, role: string, at: number, text: string) {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date(at).toISOString(),
		message:
			role === "assistant"
				? { role, content: [{ type: "text", text }], timestamp: at }
				: { role, content: text, timestamp: at },
	};
}

function setup(opts: { busy?: boolean } = {}) {
	const entries = [
		message("u1", null, "user", 1000, "first question"),
		message("a1", "u1", "assistant", 1001, "first answer"),
		message("u2", "a1", "user", 2000, "second question"),
		message("a2", "u2", "assistant", 2001, "second answer"),
	] as unknown as SdkEntry[];
	const drafts: Record<string, string> = { u1: "first question", u2: "second question" };
	let leafId: string | null = "a2";
	const navigations: Array<{ targetId: string; options: Record<string, unknown> }> = [];
	const rebuilds: string[] = [];
	const byId = (id: string) => entries.find((e) => e.id === id);
	const session = {
		sessionId: "sess-turns",
		isBusyForSnapshot: opts.busy === true,
		sessionManager: {
			getEntries: () => entries,
			getEntry: byId,
			getLeafId: () => leafId,
			getBranch: () => {
				const branch: SdkEntry[] = [];
				for (let cur = leafId ? byId(leafId) : undefined; cur;) {
					branch.unshift(cur);
					cur = cur.parentId ? byId(cur.parentId) : undefined;
				}
				return branch;
			},
			getLabel: () => undefined,
			getHeader: () => undefined,
		},
		navigateTree: async (targetId: string, options: Record<string, unknown>) => {
			navigations.push({ targetId, options });
			const target = byId(targetId)!;
			leafId = target.parentId;
			return { cancelled: false, editorText: drafts[targetId] };
		},
	};
	const entry = { handle: "s1", session } as unknown as SessionEntry;
	const handlers = createGraphModelHandlers({
		rebuildTranscript: async () => {
			rebuilds.push("rebuild");
		},
		uiContext: () => {
			throw new Error("no ask in these tests");
		},
	});
	return { handlers, entry, navigations, rebuilds };
}

describe("transcript turn actions", () => {
	test("a prompt's rewind goes past it without a summary and reports what an Undo needs", async () => {
		const t = setup();
		const answer = await t.handlers.rewindTurn(t.entry, { role: "user", at: 1000 });
		expect(t.navigations).toEqual([
			{ targetId: "u1", options: { summarize: false, requireIdle: true } },
		]);
		expect(t.rebuilds).toEqual(["rebuild"]);
		expect(answer).toMatchObject({
			entryId: "u1",
			previousLeafId: "a2",
			rewoundTurns: 2,
			editorText: "first question",
		});
	});

	test("an answer's rewind resends the last prompt before it", async () => {
		const t = setup();
		const answer = await t.handlers.rewindTurn(t.entry, { role: "assistant", at: 1001 });
		expect(t.navigations[0]?.targetId).toBe("u1");
		expect(answer).toMatchObject({ entryId: "u1", rewoundTurns: 2 });
		const later = setup();
		const last = await later.handlers.rewindTurn(later.entry, { role: "assistant", at: 2001 });
		expect(last).toMatchObject({ entryId: "u2", previousLeafId: "a2", rewoundTurns: 1 });
	});

	test("a busy session refuses before anything moves", async () => {
		const t = setup({ busy: true });
		await expect(t.handlers.rewindTurn(t.entry, { role: "user", at: 2000 })).rejects.toThrow(
			"Cannot rewind the turn",
		);
		expect(t.navigations).toEqual([]);
	});

	test("a turn that is not on the current branch is refused", async () => {
		const t = setup();
		await expect(t.handlers.rewindTurn(t.entry, { role: "user", at: 1234 })).rejects.toThrow(
			"no longer on this branch",
		);
		expect(() => t.handlers.findTurnEntry(t.entry, { role: "assistant", at: 9 })).toThrow(
			"no longer on this branch",
		);
		expect(t.navigations).toEqual([]);
	});

	test("findTurnEntry names the turn's own entry", () => {
		const t = setup();
		expect(t.handlers.findTurnEntry(t.entry, { role: "assistant", at: 1001 })).toEqual({
			entryId: "a1",
		});
		expect(t.handlers.findTurnEntry(t.entry, { role: "user", at: 2000 })).toEqual({
			entryId: "u2",
		});
	});

	test("rewindTurn reloads the transcript; findTurnEntry is read-only", () => {
		const web = createWebMethods({
			settings: {} as never,
			authStorage: {} as never,
			collab: {} as never,
			broker: {} as never,
			materializeSession: async () => ({ alreadyPresent: true as const }),
			sessionsDir: "/tmp/fleet-test-sessions",
			cwd: "/tmp/fleet-test-cwd",
			hasCallbackPair: () => false,
		});
		expect(web.methods.rewindTurn).toBeFunction();
		expect(web.readOnly.rewindTurn).toBeUndefined();
		expect(web.historyReload.rewindTurn).toBe(true);
		expect(web.notReadyGated.rewindTurn).toBeUndefined();
		expect(web.methods.findTurnEntry).toBeFunction();
		expect(web.readOnly.findTurnEntry).toBe(true);
		expect(web.historyReload.findTurnEntry).toBeUndefined();
	});
});
