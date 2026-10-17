import { describe, expect, test } from "bun:test";
import { chooseRelayUrl, decideAutoStart } from "../collab-policy";

describe("chooseRelayUrl", () => {
	test("an unset or blank relay is refused; there is no implicit default", () => {
		for (const configured of [undefined, "", "   "]) {
			const choice = chooseRelayUrl(configured);
			expect(choice.ok).toBe(false);
		}
	});

	test("the configured ws:// URL is used", () => {
		expect(chooseRelayUrl("ws://127.0.0.1:4731")).toEqual({
			ok: true,
			relayUrl: "ws://127.0.0.1:4731",
		});
	});

	test("an explicit choice overrides the configured relay", () => {
		expect(chooseRelayUrl("ws://127.0.0.1:4731", "wss://relay.example.com")).toEqual({
			ok: true,
			relayUrl: "wss://relay.example.com",
		});
	});

	test("an explicit blank choice is refused rather than falling back to the configured relay", () => {
		expect(chooseRelayUrl("ws://127.0.0.1:4731", "").ok).toBe(false);
	});

	test("non-websocket and malformed URLs are refused", () => {
		const http = chooseRelayUrl("http://127.0.0.1:4731");
		expect(http.ok).toBe(false);
		const malformed = chooseRelayUrl("not a url");
		expect(malformed.ok).toBe(false);
	});
});

describe("decideAutoStart", () => {
	test("off never starts and never refuses, whatever the relay", () => {
		expect(decideAutoStart("off", chooseRelayUrl(undefined))).toEqual({ kind: "off" });
		expect(decideAutoStart("off", chooseRelayUrl("ws://127.0.0.1:4731"))).toEqual({ kind: "off" });
	});

	test("view and control start through the configured relay", () => {
		const relay = chooseRelayUrl("ws://127.0.0.1:4731");
		expect(decideAutoStart("view", relay)).toEqual({
			kind: "start",
			relayUrl: "ws://127.0.0.1:4731",
			access: "view",
		});
		expect(decideAutoStart("control", relay)).toEqual({
			kind: "start",
			relayUrl: "ws://127.0.0.1:4731",
			access: "control",
		});
	});

	test("an enabled autoStart without a relay is refused with the reason", () => {
		const decision = decideAutoStart("view", chooseRelayUrl(undefined));
		expect(decision.kind).toBe("refuse");
		if (decision.kind !== "refuse") throw new Error("expected refusal");
		expect(decision.reason).toContain("collab.autoStart=view refused");
		expect(decision.reason).toContain("collab.relayUrl");
	});
});
