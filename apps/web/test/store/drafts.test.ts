import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	cancelScheduledDraftSave,
	clearDraft,
	deleteClearedDrafts,
	loadDraft,
	peekClearedDraft,
	removeDraft,
	saveDraft,
	scheduleDraftSave,
	type DraftBody,
	type DraftKey,
} from "../../store/drafts";

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

const originalWindow = globalThis.window;

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
	globalThis.window = {
		setTimeout: (fn: (...args: unknown[]) => void, ms?: number) =>
			setTimeout(fn, ms) as unknown as number,
		clearTimeout: (id: number) => clearTimeout(id),
	} as unknown as Window & typeof globalThis;
});

afterEach(() => {
	for (const key of usedKeys) {
		cancelScheduledDraftSave(key);
		removeDraft(key);
		deleteClearedDrafts(key);
	}
	usedKeys.length = 0;
	globalThis.window = originalWindow;
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
