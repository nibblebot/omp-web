import { afterEach, describe, expect, test } from "bun:test";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import { setState, state } from "../../state";
import { applyEvent } from "../../store/chat";

// Only `tools.intentTracing` matters here; the store reads it via settingValue.
function seedIntentTracing(value: boolean): void {
	const model = {
		tabs: [{ id: "tools", groups: [{ items: [{ path: "tools.intentTracing", value }] }] }],
	};
	setState("settingsModel", model as never);
}

function toolStart(args: Record<string, unknown>, intent?: string): AgentSessionEvent {
	return {
		type: "tool_execution_start",
		toolCallId: "t1",
		toolName: "read",
		args,
		...(intent === undefined ? {} : { intent }),
	} as unknown as AgentSessionEvent;
}

afterEach(() => {
	setState("settingsModel", null as never);
	setState("workingIntent", undefined);
});

describe("working-label intent gated on tools.intentTracing", () => {
	test("tracing on: the injected i arg becomes the working label", () => {
		seedIntentTracing(true);
		applyEvent(toolStart({ path: "a.ts", i: "reading a.ts" }));
		expect(state.workingIntent).toBe("reading a.ts");
	});

	test("tracing off: the injected i arg is withheld", () => {
		seedIntentTracing(false);
		applyEvent(toolStart({ path: "a.ts", i: "reading a.ts" }));
		expect(state.workingIntent).toBeUndefined();
	});

	test("tracing off: the resolved loop intent is withheld too", () => {
		seedIntentTracing(false);
		applyEvent(toolStart({ path: "a.ts" }, "reading a.ts"));
		expect(state.workingIntent).toBeUndefined();
	});

	test("no model loaded yet: falls back to the SDK default (on)", () => {
		setState("settingsModel", null as never);
		applyEvent(toolStart({ path: "a.ts", i: "reading a.ts" }));
		expect(state.workingIntent).toBe("reading a.ts");
	});
});
