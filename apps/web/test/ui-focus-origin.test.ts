import { afterAll, beforeAll, describe, expect, test } from "bun:test";

// focus.ts listens on `document` when it loads: give it a minimal one it can register on.
class FakeElement {}
type FocusinHandler = (event: { target: unknown }) => void;
let focusin: FocusinHandler | undefined;
const fakeDocument = {
	body: new FakeElement(),
	activeElement: null as unknown,
	addEventListener: (type: string, handler: FocusinHandler) => {
		if (type === "focusin") focusin = handler;
	},
};
const globals = globalThis as Record<string, unknown>;
const saved = { document: globals["document"], HTMLElement: globals["HTMLElement"] };
let focusOrigin: () => unknown;

beforeAll(async () => {
	globals["document"] = fakeDocument;
	globals["HTMLElement"] = FakeElement;
	const path: string = "../components/ui/focus.ts?fresh=origin";
	({ focusOrigin } = await import(path));
});

afterAll(() => {
	globals["document"] = saved.document;
	globals["HTMLElement"] = saved.HTMLElement;
});

describe("focusOrigin", () => {
	test("remembers the last focused element while it is alive", () => {
		fakeDocument.activeElement = fakeDocument.body;
		const el = new FakeElement();
		focusin!({ target: el });
		expect(focusOrigin()).toBe(el);
	});

	test("does not keep a focused element alive: a closed dialog's DOM can be collected", async () => {
		fakeDocument.activeElement = fakeDocument.body;
		let collected = false;
		(() => focusin!({ target: new FakeElement() }))();
		// A WeakRef target stays alive until the end of the current task, so yield to the next one before collecting.
		for (let i = 0; i < 20 && !collected; i++) {
			await new Promise((resolve) => setImmediate(resolve));
			Bun.gc(true);
			collected = focusOrigin() === null;
		}
		expect(collected).toBe(true);
	});
});
