import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	cancelScheduledDraftSave,
	currentDraftKey,
	draftKey,
	loadDraft,
	removeDraft,
	saveDraft,
	scheduleDraftSave,
	swapDraft,
	type DraftBody,
	type DraftKey,
} from "../../store/drafts";
import type { TextAttachment } from "../../prompt/attachments";
import { setState, state } from "../../state";
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

	test("removeDraft clears the live slot", () => {
		const key = freshKey("remove-live");
		saveDraft(key, body("live v1"));
		removeDraft(key);
		expect(loadDraft(key)).toBeNull();
	});

	test("submit simulation: cancel + remove beats the pending pre-send save", async () => {
		const key = freshKey("submit");
		saveDraft(key, body("sent prompt"));
		// Keystrokes armed a debounced save closing over the pre-send text.
		scheduleDraftSave(key, body("sent prompt"), 5);
		// Submit path: cancel the pending save, then delete the live slot.
		cancelScheduledDraftSave(key);
		removeDraft(key);
		await delay(20);
		expect(loadDraft(key)).toBeNull();
	});
});

describe("drafts (retired cleared rings)", () => {
	test("loadDraft sweeps stored cleared-ring keys and keeps the live draft", () => {
		const stored = new Map<string, string>();
		setBrowserGlobal("localStorage", {
			get length() {
				return stored.size;
			},
			key: (i: number) => [...stored.keys()][i] ?? null,
			getItem: (k: string) => stored.get(k) ?? null,
			setItem: (k: string, v: string) => void stored.set(k, v),
			removeItem: (k: string) => void stored.delete(k),
		} as unknown as Storage);
		const key = freshKey("legacy-sweep");
		const legacy = "omp-web:draft-cleared:v2:test¦legacy-sweep¦main¦main";
		stored.set(legacy, JSON.stringify([body("old ring entry")]));
		saveDraft(key, body("live"));
		expect(loadDraft(key)?.text).toBe("live");
		expect(stored.has(legacy)).toBe(false);
	});
});

describe("drafts (text-file chips)", () => {
	const file = (name: string, text: string): TextAttachment => ({
		id: `att-${name}`,
		name,
		size: text.length,
		text,
	});

	test("chips survive save and restore; an oversize chip is marked not kept", () => {
		const key = freshKey("chip-restore");
		const small = file("a.ts", "A");
		const big = file("big.txt", "x".repeat(400_001));
		saveDraft(key, { text: "look", images: [], files: [small, big], updatedAt: 1000 });
		const restored = loadDraft(key);
		expect(restored?.files?.[0]).toEqual(small);
		expect(restored?.files?.[1]?.name).toBe("big.txt");
		expect(restored?.files?.[1]?.text).toBeUndefined();
		expect(restored?.files?.[1]?.error).toBe("Not kept with the draft; attach it again.");
		removeDraft(key);
	});
});

describe("drafts (per-session partitions)", () => {
	test("each attached session gets its own slot; none while its id is pending", () => {
		const prior = { currentWorkspaceId: state.currentWorkspaceId, sessionId: state.sessionId };
		try {
			setState({ currentWorkspaceId: "d1", sessionId: "s1" });
			const first = currentDraftKey();
			setState({ currentWorkspaceId: "d2", sessionId: "s1" });
			const otherWorkspace = currentDraftKey();
			setState({ currentWorkspaceId: "d1", sessionId: "s2" });
			const otherSession = currentDraftKey();
			expect(first).not.toBeNull();
			expect(new Set([first, otherWorkspace, otherSession].map((k) => k?.sessionId)).size).toBe(3);
			setState({ sessionId: "" });
			expect(currentDraftKey()).toBeNull();
		} finally {
			setState(prior);
		}
	});

	test("switching sessions stores the leaving draft and shows the arriving one", () => {
		const a = freshKey("swap-a");
		const b = freshKey("swap-b");
		expect(swapDraft(undefined, a, body(""))).toBeNull();
		expect(swapDraft(a, b, body("alpha"))?.text).toBe("");
		expect(swapDraft(b, a, body("beta"))?.text).toBe("alpha");
		expect(swapDraft(a, b, body("alpha"))?.text).toBe("beta");
	});

	test("content typed while the session id is pending stays for the arriving session", () => {
		const a = freshKey("pending-a");
		const b = freshKey("pending-b");
		expect(swapDraft(a, null, body("alpha"))?.text).toBe("");
		expect(swapDraft(null, b, body("early"))).toBeNull();
		expect(loadDraft(b)?.text).toBe("early");
		expect(loadDraft(a)?.text).toBe("alpha");
	});
});

describe("drafts (incremental persistence)", () => {
	const png = (n: number): { type: "image"; data: string; mimeType: string } => ({
		type: "image",
		data: `${n}`.repeat(1000),
		mimeType: "image/png",
	});
	let stored: Map<string, string>;
	let writes: string[];
	let bytesWritten: number;

	beforeEach(() => {
		stored = new Map();
		writes = [];
		bytesWritten = 0;
		setBrowserGlobal("localStorage", {
			get length() {
				return stored.size;
			},
			key: (i: number) => [...stored.keys()][i] ?? null,
			getItem: (k: string) => stored.get(k) ?? null,
			setItem: (k: string, v: string) => {
				writes.push(k);
				bytesWritten += v.length;
				stored.set(k, v);
			},
			removeItem: (k: string) => void stored.delete(k),
		} as unknown as Storage);
	});

	test("images and chips survive save and restore", () => {
		const key = freshKey("att-roundtrip");
		const chip: TextAttachment = { id: "a", name: "a.ts", size: 1, text: "A" };
		const images = [png(1), png(2)];
		saveDraft(key, { text: "look", images, files: [chip], updatedAt: 1 });
		const restored = loadDraft(key);
		expect(restored?.text).toBe("look");
		expect(restored?.images).toEqual(images);
		expect(restored?.files).toEqual([chip]);
	});

	test("typing next to attached images rewrites the text, not the attachments", () => {
		const key = freshKey("att-typing");
		const images = [png(1)];
		saveDraft(key, { text: "a", images, updatedAt: 1 });
		bytesWritten = 0;
		for (const text of ["ab", "abc", "abcd"]) saveDraft(key, { text, images, updatedAt: 2 });
		// The 1000-character image is not part of what typing writes.
		expect(bytesWritten).toBeLessThan(500);
		expect(loadDraft(key)).toMatchObject({ text: "abcd", images });
	});

	test("a save that changes nothing writes nothing", () => {
		const key = freshKey("att-unchanged");
		const images = [png(1)];
		saveDraft(key, { text: "same", images, updatedAt: 1 });
		writes.length = 0;
		saveDraft(key, { text: "same", images: [...images], updatedAt: 2 });
		expect(writes).toEqual([]);
	});

	test("removing the last image drops the stored attachments", () => {
		const key = freshKey("att-removed");
		saveDraft(key, { text: "t", images: [png(1)], updatedAt: 1 });
		saveDraft(key, { text: "t", images: [], updatedAt: 2 });
		expect(loadDraft(key)?.images).toEqual([]);
		expect([...stored.keys()].filter((k) => k.endsWith("#attachments"))).toEqual([]);
	});

	test("removeDraft clears text and attachments", () => {
		const key = freshKey("att-remove");
		saveDraft(key, { text: "t", images: [png(1)], updatedAt: 1 });
		removeDraft(key);
		expect(loadDraft(key)).toBeNull();
		expect(stored.size).toBe(0);
		// The save memo is gone too: the same draft is written in full again.
		saveDraft(key, { text: "t", images: [png(1)], updatedAt: 3 });
		expect(loadDraft(key)?.images).toEqual([png(1)]);
	});

	test("a draft stored with its images inline still loads", () => {
		const key = freshKey("att-legacy");
		const images = [png(3)];
		stored.set(
			"omp-web:draft:v2:test¦att-legacy¦main¦main",
			JSON.stringify({ text: "old", images, updatedAt: 5 }),
		);
		expect(loadDraft(key)).toMatchObject({ text: "old", images });
	});
});

describe("drafts (another tab writes the same slot)", () => {
	const png = (n: number): { type: "image"; data: string; mimeType: string } => ({
		type: "image",
		data: `${n}`.repeat(1000),
		mimeType: "image/png",
	});
	let stored: Map<string, string>;
	let listeners: ((e: { key: string | null }) => void)[];

	beforeEach(() => {
		stored = new Map();
		listeners = [];
		setBrowserGlobal("localStorage", {
			get length() {
				return stored.size;
			},
			key: (i: number) => [...stored.keys()][i] ?? null,
			getItem: (k: string) => stored.get(k) ?? null,
			setItem: (k: string, v: string) => void stored.set(k, v),
			removeItem: (k: string) => void stored.delete(k),
		} as unknown as Storage);
		setBrowserGlobal("window", {
			setTimeout: (fn: (...args: unknown[]) => void, ms?: number) =>
				setTimeout(fn, ms) as unknown as number,
			clearTimeout: (id: number) => clearTimeout(id),
			addEventListener: (type: string, fn: (e: { key: string | null }) => void) => {
				if (type === "storage") listeners.push(fn);
			},
		} as unknown as Window & typeof globalThis);
	});

	/** The other tab sent: it removed both entries of the slot; this tab hears one event per key. */
	function otherTabRemoves(key: DraftKey): void {
		const slot = draftKey(key);
		for (const k of [slot, `${slot}#attachments`]) {
			stored.delete(k);
			for (const fn of listeners) fn({ key: k });
		}
	}

	test("typing after the other tab removed the draft still stores the images", () => {
		const key = freshKey("tab-typing");
		const images = [png(1)];
		saveDraft(key, { text: "hello", images, updatedAt: 1 });
		otherTabRemoves(key);
		saveDraft(key, { text: "hello world", images, updatedAt: 2 });
		expect(loadDraft(key)).toMatchObject({ text: "hello world", images });
	});

	test("adding an image after the other tab removed the draft keeps the text", () => {
		const key = freshKey("tab-image");
		saveDraft(key, { text: "hello", images: [], updatedAt: 1 });
		otherTabRemoves(key);
		saveDraft(key, { text: "hello", images: [png(2)], updatedAt: 2 });
		expect(loadDraft(key)).toMatchObject({ text: "hello", images: [png(2)] });
	});

	test("a storage clear drops the memo too", () => {
		const key = freshKey("tab-clear");
		const images = [png(3)];
		saveDraft(key, { text: "abc", images, updatedAt: 1 });
		stored.clear();
		for (const fn of listeners) fn({ key: null });
		saveDraft(key, { text: "abc", images, updatedAt: 2 });
		expect(loadDraft(key)).toMatchObject({ text: "abc", images });
	});
});
