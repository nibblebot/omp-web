/**
 * Header share entry points: the palette's "Share session" item opens the
 * ShareSheet (modal "share"), and the header "Live · N" badge renders only
 * while the collab status is live. Rendered through solid's SSR runtime.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { LiveShareBadge, liveGuestCount } from "../../components/chat/status/LiveShareBadge";
import { openItems } from "../../palette/palette";
import { setState, state } from "../../state";
import { runPaletteItem } from "../../store/palette";
import type { CollabWireStatus } from "#lib/wire/protocol";
import {
	installJsxShim,
	installLocalStorageShim,
	restoreBrowserGlobals,
	restoreJsxShim,
} from "../web.testkit";

const LIVE: CollabWireStatus = {
	state: "live",
	link: "wss://relay.example/r/1#control",
	viewLink: "wss://relay.example/r/1#view",
	access: "control",
	relayUrl: "wss://relay.example",
	roomId: "1",
	maxGuests: 4,
	participants: [
		{ name: "host", role: "host" },
		{ name: "ada", role: "guest" },
		{ name: "lin", role: "guest", readOnly: true },
	],
};

/** Write a fresh literal: the shared COLLAB_OFF object can be skipped by the store. */
const setStatus = (status: CollabWireStatus) => setState({ collabStatus: status });
const render = () => renderToString(() => createComponent(LiveShareBadge, {}));

beforeEach(() => {
	installLocalStorageShim();
	restoreJsxShim();
	installJsxShim({});
	setState("modal", null);
	setStatus({ state: "off" });
});

afterEach(restoreBrowserGlobals);

afterAll(() => {
	restoreJsxShim();
	setStatus({ state: "off" });
	setState("modal", null);
});

describe("palette Share session", () => {
	const items = () =>
		openItems({
			debugEnabled: false,
			pluginsEnabled: false,
			providerLoginEnabled: false,
			projects: [],
		});

	test("is listed in the Open group", () => {
		const item = items().find((i) => i.label === "Share session");
		expect(item).toMatchObject({ group: "Open", action: { kind: "open", target: "share" } });
	});

	test("choosing it opens the ShareSheet", () => {
		runPaletteItem(items().find((i) => i.label === "Share session")!);
		expect(state.modal).toBe("share");
	});
});

describe("Live share badge", () => {
	test("renders nothing unless the room is live", () => {
		for (const status of [
			{ state: "off" },
			{ state: "starting" },
			{ state: "error", error: "relay refused" },
		] as CollabWireStatus[]) {
			setStatus(status);
			expect(render()).not.toContain("live-share-badge");
		}
	});

	test("appears while live with the guest count, and goes away when the room ends", () => {
		setStatus(LIVE);
		const html = render();
		expect(html).toContain("live-share-badge");
		expect(html).toContain("Live");
		expect(html).toContain("2");
		setStatus({ state: "off" });
		expect(render()).not.toContain("live-share-badge");
	});

	test("counts guests only, never the host", () => {
		expect(liveGuestCount(LIVE)).toBe(2);
		expect(liveGuestCount({ state: "off" })).toBe(0);
	});
});
