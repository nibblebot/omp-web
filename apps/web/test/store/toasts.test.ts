import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { setState, state } from "../../state";
import { TOAST_DISMISS_MS, dismissToast, pushToast } from "../../store/toasts";
import { restoreBrowserGlobals, setBrowserGlobal } from "../web.testkit";

// ---------------------------------------------------------------------------
// Toast store behavior. window.setTimeout is stubbed with a controllable
// clock (same pattern as src/prompt/commands.test.ts) so the 6s auto-dismiss
// path is exercised deterministically, with no real waiting or fake timers.
// ---------------------------------------------------------------------------
type CapturedTimer = { fn: () => void; ms: number };

const timers: CapturedTimer[] = [];

beforeEach(() => {
	timers.length = 0;
	setBrowserGlobal("window", {
		setTimeout: (fn: () => void, ms?: number) => {
			timers.push({ fn, ms: ms ?? 0 });
			return timers.length;
		},
	} as unknown as Window & typeof globalThis);
	setState("toasts", []);
});

afterEach(restoreBrowserGlobals);

function toastTexts(): string[] {
	return state.toasts.map((t) => t.text);
}

describe("toasts (fleet/app-scoped ephemeral notifications)", () => {
	test("pushToast appends newest last; dismissToast removes only its own id", () => {
		pushToast("alpha");
		pushToast("beta");
		expect(toastTexts()).toEqual(["alpha", "beta"]);
		expect(typeof state.toasts[0].id).toBe("number");
		expect(state.toasts[1].id).not.toBe(state.toasts[0].id);

		dismissToast(state.toasts[0].id);
		expect(toastTexts()).toEqual(["beta"]);
	});

	test("the list is capped at 5 (oldest dropped)", () => {
		for (let i = 1; i <= 6; i++) pushToast(`t${i}`);
		expect(state.toasts).toHaveLength(5);
		expect(toastTexts()).toEqual(["t2", "t3", "t4", "t5", "t6"]);
	});

	test("each push schedules an auto-dismiss timer at TOAST_DISMISS_MS that removes only its toast", () => {
		pushToast("a");
		pushToast("b");
		expect(timers).toHaveLength(2);
		expect(timers.every((t) => t.ms === TOAST_DISMISS_MS)).toBe(true);

		// Fire the newest timer (belongs to "b"): only "b" is dismissed.
		timers[1].fn();
		expect(toastTexts()).toEqual(["a"]);

		timers[0].fn();
		expect(state.toasts).toEqual([]);
	});

	test("a stale auto-dismiss timer after a manual dismiss is a no-op", () => {
		pushToast("c");
		dismissToast(state.toasts[0].id);
		expect(state.toasts).toEqual([]);

		// The timer armed for "c" fires late; its id is already gone.
		timers[0].fn();
		expect(state.toasts).toEqual([]);
	});

	test("an action toast keeps its action and honors a custom duration", () => {
		const calls: string[] = [];
		pushToast("Draft discarded", {
			durationMs: 10_000,
			action: { label: "Undo", run: () => calls.push("undo") },
		});
		expect(timers[0].ms).toBe(10_000);
		expect(state.toasts[0].action?.label).toBe("Undo");
		state.toasts[0].action?.run();
		expect(calls).toEqual(["undo"]);

		pushToast("plain");
		expect(state.toasts[1].action).toBeUndefined();
		expect(timers[1].ms).toBe(TOAST_DISMISS_MS);
	});
});
