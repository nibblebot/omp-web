import { describe, expect, test } from "bun:test";
import { guardDraftEscape } from "../../store/review";

/** Minimal keydown: DockPane closes on an Escape whose `defaultPrevented` is false. */
function keydown(key: string): KeyboardEvent {
	const event = {
		key,
		defaultPrevented: false,
		preventDefault() {
			event.defaultPrevented = true;
		},
	};
	return event as unknown as KeyboardEvent;
}

describe("review draft Esc guard", () => {
	test("Esc in a field holding a draft is claimed, so the dock stays open and the draft survives", () => {
		const event = keydown("Escape");
		guardDraftEscape(event, "fix: handle empty input");
		expect(event.defaultPrevented).toBe(true);
	});

	test("Esc in an empty or whitespace-only field still closes the dock", () => {
		for (const draft of ["", "  \n"]) {
			const event = keydown("Escape");
			guardDraftEscape(event, draft);
			expect(event.defaultPrevented).toBe(false);
		}
	});

	test("other keys are never claimed", () => {
		const event = keydown("Enter");
		guardDraftEscape(event, "draft");
		expect(event.defaultPrevented).toBe(false);
	});
});
