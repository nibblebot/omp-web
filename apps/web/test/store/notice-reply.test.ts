import { describe, expect, test } from "bun:test";
import type { WireSessionEvent } from "#lib/wire/protocol";
import { state } from "../../state";
import { applyEvent } from "../../store/chat";

function notice(extra: Record<string, unknown>): WireSessionEvent {
	return {
		type: "notice",
		level: "info",
		message: "Added /tmp/extra to the workspace.",
		...extra,
	} as unknown as WireSessionEvent;
}

describe("forwarded command reply header (U10b, CMD-09)", () => {
	test("a notice tagged with its command keeps the command for the reply header", () => {
		const before = state.items.length;
		applyEvent(notice({ command: "/add-dir" }));
		expect(state.items.slice(before)).toMatchObject([
			{ kind: "notice", level: "info", command: "/add-dir" },
		]);
	});

	test("an untagged notice has no command header", () => {
		const before = state.items.length;
		applyEvent(notice({}));
		const [item] = state.items.slice(before);
		expect(item).toMatchObject({ kind: "notice", level: "info" });
		expect(item && "command" in item ? item.command : undefined).toBeUndefined();
	});

	test("a non-string command tag is dropped instead of rendering a bogus header", () => {
		const before = state.items.length;
		applyEvent(notice({ command: 42 }));
		const [item] = state.items.slice(before);
		expect(item && "command" in item ? item.command : undefined).toBeUndefined();
	});
});
