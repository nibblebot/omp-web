import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	cancelScheduledDraftSave,
	clearDraft,
	deleteClearedDrafts,
	listClearedDrafts,
	loadDraft,
	peekClearedDraft,
	recoverClearedDraft,
	removeDraft,
	saveDraft,
	scheduleDraftSave,
	takeClearedDraft,
	type DraftBody,
	type DraftKey,
} from "../../store/drafts";
import { promptInsert, setPromptInsert } from "../../state";
import { restoreBrowserGlobals, setBrowserGlobal } from "../web.testkit";

// ---------------------------------------------------------------------------
// Ghost-draft guards: a sent prompt must never return to the composer. Real
// timers with tiny delays (≤20ms), no DOM: only a minimal window
// setTimeout/clearTimeout shim is needed (Bun has no browser globals); draft
// storage falls back to the module's in-memory map. Each test owns a unique
// partition key and afterEach cancels pending timers + wipes both slots, so
// tests stay isolated despite the module-level fallback map.
//
// Real-timer integration: these tests exercise the live platform clock path
// the composer relies on, which deterministic time control cannot cover.
// ---------------------------------------------------------------------------

const usedKeys: DraftKey[] = [];

function freshKey(id: string): DraftKey {
	const key: DraftKey = { origin: "test", sessionId: id, branchId: "main", agentId: "main" };
	usedKeys.push(key);
	return key;
}

function body(text: string): DraftBody {
	return { text, images: [], updatedAt: Date.now() };
}

function delay(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

beforeEach(() => {
	setBrowserGlobal("window", {
		setTimeout: (fn: (...args: unknown[]) => void, ms?: number) =>
			setTimeout(fn, ms) as unknown as number,
		clearTimeout: (id: number) => clearTimeout(id),
	} as unknown as Window & typeof globalThis);
});

afterEach(() => {
	for (const key of usedKeys) {
		cancelScheduledDraftSave(key);
		removeDraft(key);
		deleteClearedDrafts(key);
	}
	usedKeys.length = 0;
	restoreBrowserGlobals();
});

describe("drafts (ghost-draft guards)", () => {
	test("save→load roundtrip", () => {
		const key = freshKey("roundtrip");
		expect(saveDraft(key, body("hello world"))).toBe(true);
		expect(loadDraft(key)?.text).toBe("hello world");
	});

	test("scheduled save lands after the delay", async () => {
		const key = freshKey("scheduled-lands");
		scheduleDraftSave(key, body("debounced text"), 5);
		// Not yet persisted: the save is deferred.
		expect(loadDraft(key)).toBeNull();
		await delay(20);
		expect(loadDraft(key)?.text).toBe("debounced text");
	});

	test("schedule-then-cancel leaves loadDraft null after the delay passes", async () => {
		const key = freshKey("scheduled-cancelled");
		scheduleDraftSave(key, body("never lands"), 5);
		cancelScheduledDraftSave(key);
		await delay(20);
		expect(loadDraft(key)).toBeNull();
	});

	test("removeDraft clears the live slot but preserves the cleared ring", () => {
		const key = freshKey("remove-keeps-ring");
		saveDraft(key, body("discarded v1"));
		clearDraft(key);
		saveDraft(key, body("live v2"));
		removeDraft(key);
		expect(loadDraft(key)).toBeNull();
		expect(peekClearedDraft(key)?.text).toBe("discarded v1");
	});

	test("submit simulation: cancel + remove beats the pending pre-send save", async () => {
		const key = freshKey("submit");
		saveDraft(key, body("sent prompt"));
		// Keystrokes armed a debounced save closing over the pre-send text.
		scheduleDraftSave(key, body("sent prompt"), 5);
		// Submit path: cancel the pending save, delete the live slot (sent,
		// not discarded: no ring entry).
		cancelScheduledDraftSave(key);
		removeDraft(key);
		await delay(20);
		expect(loadDraft(key)).toBeNull();
		expect(peekClearedDraft(key)).toBeNull();
	});
});

describe("drafts (discard undo and history recovery)", () => {
	test("discard then undo restores text, images and caret, and drops the ring entry", () => {
		const key = freshKey("undo-restore");
		const image = { type: "image" as const, data: "AAAA", mimeType: "image/png" };
		const draft: DraftBody = {
			text: "keep this",
			images: [image],
			selectionStart: 4,
			selectionEnd: 4,
			updatedAt: 1_700_000_000_000,
		};
		saveDraft(key, draft);
		clearDraft(key);
		expect(loadDraft(key)).toBeNull();
		expect(listClearedDrafts(key)).toHaveLength(1);

		takeClearedDraft(key, draft);
		expect(promptInsert()).toEqual({
			text: "keep this",
			images: [image],
			selection: { start: 4, end: 4 },
		});
		expect(listClearedDrafts(key)).toEqual([]);
		setPromptInsert(null);
	});

	test("undo removes only its own ring entry, leaving an identical older discard", () => {
		const key = freshKey("undo-exact");
		const older: DraftBody = { text: "same", images: [], updatedAt: 1000 };
		const newer: DraftBody = { text: "same", images: [], updatedAt: 2000 };
		saveDraft(key, older);
		clearDraft(key);
		saveDraft(key, newer);
		clearDraft(key);

		takeClearedDraft(key, newer);
		expect(listClearedDrafts(key).map((b) => b.updatedAt)).toEqual([1000]);
		setPromptInsert(null);
	});

	test("discarded drafts list newest first; recover still pops the newest", () => {
		const key = freshKey("picker-order");
		saveDraft(key, body("first"));
		clearDraft(key);
		saveDraft(key, body("second"));
		clearDraft(key);
		expect(listClearedDrafts(key).map((b) => b.text)).toEqual(["second", "first"]);

		expect(recoverClearedDraft(key)?.text).toBe("second");
		expect(listClearedDrafts(key).map((b) => b.text)).toEqual(["first"]);
		setPromptInsert(null);
		deleteClearedDrafts(key);
	});
});
