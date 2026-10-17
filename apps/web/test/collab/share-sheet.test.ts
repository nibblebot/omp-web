/**
 * ShareSheet and guest prompt card render branches: the browser link and its
 * QR appear only when the daemon supplies one (self-hosted relays do not),
 * the public-relay opt-in shows until a relay is chosen, and a guest prompt
 * renders with its sender. Rendered through solid's SSR runtime; the Modal
 * shell is intercepted so only the sheet body is asserted.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import * as solidWeb from "solid-js/web";
import { ShareSheet } from "../../components/collab/ShareSheet";
import { GuestPromptCard } from "../../components/chat/transcript/cards/GuestPromptCard";
import { Modal } from "../../components/ui/Modal";
import { setState, type ChatItem } from "../../state";
import type { CollabWireStatus } from "#lib/wire/protocol";
import { installJsxShim, restoreJsxShim } from "../web.testkit";

beforeEach(() => {
	installJsxShim({
		onElement(type, props) {
			return type === Modal ? { value: props.children } : undefined;
		},
	});
});

afterAll(() => {
	restoreJsxShim();
});

const RELAY = "wss://relay.example";

function live(
	overrides: Partial<Extract<CollabWireStatus, { state: "live" }>> = {},
): CollabWireStatus {
	return {
		state: "live",
		link: `${RELAY}/r/1#control`,
		viewLink: `${RELAY}/r/1#view`,
		access: "control",
		relayUrl: RELAY,
		roomId: "1",
		maxGuests: 4,
		participants: [
			{ name: "host", role: "host" },
			{ name: "ada", role: "guest" },
		],
		...overrides,
	};
}

/** Render the sheet with `status` and the relay setting; returns the markup. */
function renderSheet(status: CollabWireStatus, relayUrl: string): string {
	setState({
		collabStatus: { state: "off" },
		settingsModel: {
			tabs: [
				{ id: "interaction", groups: [{ items: [{ path: "collab.relayUrl", value: relayUrl }] }] },
			],
		} as never,
	});
	setState({ collabStatus: status });
	return solidWeb.renderToString(() => createComponent(ShareSheet, { onClose: () => {} }));
}

describe("ShareSheet browser link", () => {
	test("shows the browser link and its QR when the daemon supplies one", () => {
		const html = renderSheet(
			live({ browserLink: "https://web.example/#wss://relay.example/r/1#control" }),
			RELAY,
		);
		expect(html).toContain('aria-label="Browser link"');
		expect(html).toContain('aria-label="QR code for the browser link"');
	});

	test("hides the browser link when the relay has no browser client", () => {
		const html = renderSheet(live(), RELAY);
		expect(html).not.toContain("Browser link");
		expect(html).not.toContain("QR code for the browser link");
		expect(html).toContain("omp join");
	});

	test("shows the live header with the guest count", () => {
		const html = renderSheet(live(), RELAY);
		expect(html).toContain("Live · 1 guest");
	});
});

describe("ShareSheet relay opt-in", () => {
	test("an unset relay shows the public-relay disclosure before any start", () => {
		const html = renderSheet({ state: "off" }, "");
		expect(html).toContain("No relay is configured");
		expect(html).toContain("Use public relay, view only");
		expect(html).not.toContain("Share, view only");
	});

	test("a configured relay shows the plain start choices", () => {
		const html = renderSheet({ state: "off" }, RELAY);
		expect(html).toContain("Share, view only");
		expect(html).not.toContain("No relay is configured");
	});
});

describe("GuestPromptCard", () => {
	test("shows the sender and the prompt text", () => {
		const item = { kind: "guestPrompt", id: 1, from: "ada", text: "run the tests" } as Extract<
			ChatItem,
			{ kind: "guestPrompt" }
		>;
		const html = solidWeb.renderToString(() => createComponent(GuestPromptCard, { item }));
		expect(html).toContain("Guest · ada");
		expect(html).toContain("run the tests");
	});
});
