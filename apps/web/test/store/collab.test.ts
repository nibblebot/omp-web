import { describe, expect, test } from "bun:test";
import { COLLAB_OFF, collabLive, guestPromptOf } from "../../store/slices/collab";

const liveBase = {
	state: "live" as const,
	link: "wss://relay.example/r/1#control",
	viewLink: "wss://relay.example/r/1#view",
	access: "control" as const,
	relayUrl: "wss://relay.example",
	roomId: "1",
	maxGuests: 4,
	participants: [{ name: "host", role: "host" as const }],
};

describe("collabLive", () => {
	test("only a live room counts as shared", () => {
		expect(collabLive(COLLAB_OFF)).toBe(false);
		expect(collabLive({ state: "starting" })).toBe(false);
		expect(collabLive({ state: "error", error: "relay refused" })).toBe(false);
		expect(collabLive(liveBase)).toBe(true);
	});
});

describe("guestPromptOf", () => {
	test("reads a display collab-prompt from a guest", () => {
		const message = {
			role: "custom",
			customType: "collab-prompt",
			display: true,
			content: "run the tests",
			details: { from: "ada" },
		};
		expect(guestPromptOf(message)).toEqual({ from: "ada", text: "run the tests" });
	});

	test("defaults the sender name and joins text parts only", () => {
		const message = {
			role: "custom",
			customType: "collab-prompt",
			display: true,
			content: [
				{ type: "text", text: "first" },
				{ type: "image", data: "..." },
				{ type: "text", text: "second" },
			],
		};
		expect(guestPromptOf(message)).toEqual({ from: "guest", text: "first\nsecond" });
	});

	test("ignores other custom messages and hidden ones", () => {
		expect(
			guestPromptOf({ role: "custom", customType: "advisor", display: true, content: "x" }),
		).toBeNull();
		expect(
			guestPromptOf({ role: "custom", customType: "collab-prompt", display: false, content: "x" }),
		).toBeNull();
		expect(guestPromptOf({ role: "user", content: "x" })).toBeNull();
	});
});
