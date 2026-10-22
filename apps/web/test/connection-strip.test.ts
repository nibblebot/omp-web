/**
 * Killing the attached session process: roster truth (asleep/error) moves the
 * view to "offline", the connection strip renders with the offline state, and
 * session-bound actions render disabled. A removed entry is not offline: the
 * view moves to a neighbouring session or clears to the no-session pane.
 *
 * Store path: a roster frame drives reconcileAttachedSession, which sets
 * sessionDownId (asleep/error only) and clears currentSessionId. Component path: ConnectionBar,
 * SessionTitle (New session) and PromptActions (Send) render through solid's
 * SSR runtime (see the shared JSX shim).
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import * as solidWeb from "solid-js/web";
import type { DaemonEntry, ServerFrame } from "#lib/wire/protocol";
import { ConnectionBar } from "../components/app/ConnectionBar";
import { WorkspaceRow, setMenuOpenId } from "../components/fleet/sidebar/WorkspaceRow";
import { PromptActions } from "../components/chat/composer/PromptActions";
import { SessionTitle } from "../components/chat/status/SessionTitle";
import { connect, connectionState, setState, state } from "../state";
import {
	attached,
	dispatch,
	dispatchSeq,
	FakeEventSource,
	installJsxShim,
	installTransportStubs,
	restoreBrowserGlobals,
	restoreJsxShim,
} from "./web.testkit";

function daemon(id: string, extra: Partial<DaemonEntry> = {}): DaemonEntry {
	return {
		daemonId: id,
		name: id,
		cwd: `/repos/${id}`,
		project: id,
		labels: [],
		status: "ready",
		...extra,
	};
}

/** Attach to daemon-a with its priming series done and the composer ready. */
function attachReady(): void {
	connect();
	FakeEventSource.instances.at(-1)!.onopen?.();
	dispatch({ type: "roster", daemons: [daemon("daemon-a")] });
	dispatch(attached("daemon-a"));
	dispatchSeq({ type: "history", messages: [] } as ServerFrame, 3);
	setState("readyAt", 123);
}

/** A row's kebab menu, open, rendered as it is in the current state. */
function renderRowMenu(entry: DaemonEntry): string {
	setMenuOpenId(entry.daemonId);
	try {
		return solidWeb.renderToString(() => createComponent(WorkspaceRow, { daemon: entry }));
	} finally {
		setMenuOpenId(null);
	}
}

/** Render the strip, the session title, and the composer actions as they are in the current state. */
function renderChrome(): { strip: string; title: string; actions: string } {
	const strip = solidWeb.renderToString(() => createComponent(ConnectionBar, {}));
	const title = solidWeb.renderToString(() => createComponent(SessionTitle, {}));
	const actions = solidWeb.renderToString(() =>
		createComponent(PromptActions, {
			message: () => "hello",
			images: () => [],
			files: () => [],
			submit: () => {},
		}),
	);
	return { strip, title, actions };
}

beforeEach(() => {
	installTransportStubs();
	installJsxShim();
	attachReady();
});

afterEach(() => {
	// The module-level store outlives each test; reset it so the next
	// connect() opens a fresh stream and the next roster frame applies.
	setState({
		connected: false,
		transportStartup: true,
		sessionDownId: "",
		currentSessionId: "",
		daemonRoster: [],
		readyAt: undefined,
	});
});

afterAll(() => {
	restoreJsxShim();
	restoreBrowserGlobals();
});

describe("transport strip", () => {
	test("stays hidden while the page's first stream is opening, and shows once a connected stream drops", () => {
		setState({ connected: false, transportStartup: true, currentSessionId: "" });
		expect(connectionState()).toBe("reconnecting");
		expect(renderChrome().strip).not.toContain("connection-bar");
		// After the first open (or the startup grace), a down stream is a real reconnect.
		setState({ transportStartup: false });
		expect(renderChrome().strip).toContain('data-state="reconnecting"');
	});
});

describe("killed attached session process", () => {
	test("while the session is attached and ready, the strip is hidden and actions are enabled", () => {
		expect(connectionState()).toBe("connected");
		const { strip, title, actions } = renderChrome();
		expect(strip).not.toContain("connection-bar");
		expect(title).not.toMatch(/<button[^>]*disabled[^>]*aria-label="New session"/);
		expect(title).toMatch(/<button[^>]*aria-label="New session"/);
		expect(actions).not.toMatch(/<button(?=[^>]*aria-label="Send")(?=[^>]*\bdisabled)/);
	});

	test.each(["asleep", "error"] as const)(
		"a roster status of %s moves the view to offline and shows the strip",
		(status) => {
			dispatch({ type: "roster", daemons: [daemon("daemon-a", { status })] });

			expect(state.sessionDownId).toBe("daemon-a");
			expect(state.currentSessionId).toBe("");
			expect(connectionState()).toBe("offline");

			const { strip, title, actions } = renderChrome();
			expect(strip).toContain("connection-bar");
			expect(strip).toContain('data-state="offline"');
			expect(title).toMatch(/<button[^>]*disabled[^>]*aria-label="New session"/);
			expect(actions).toMatch(/<button(?=[^>]*aria-label="Send")(?=[^>]*\bdisabled)/);
		},
	);

	test("a removed roster entry with no session left clears the view without the offline strip", () => {
		dispatch({ type: "roster", daemons: [] });
		expect(state.sessionDownId).toBe("");
		expect(state.currentSessionId).toBe("");
		expect(state.transcriptPhase).toBe("idle");
		expect(connectionState()).toBe("connected");
		expect(renderChrome().strip).not.toContain("connection-bar");
	});

	test("a fresh attach after the kill clears the offline strip", () => {
		dispatch({ type: "roster", daemons: [daemon("daemon-a", { status: "asleep" })] });
		expect(connectionState()).toBe("offline");
		dispatch({ type: "roster", daemons: [daemon("daemon-a")] });
		dispatch(attached("daemon-a"));
		expect(state.sessionDownId).toBe("");
		expect(connectionState()).toBe("connected");
		expect(renderChrome().strip).not.toContain("connection-bar");
	});

	// The strip describes the dead attached session; the fleet transport is still
	// up, so fleet-scoped row actions (start, restart, switching rows) must stay
	// live, or the user has no way out of the offline view.
	test.each([
		["asleep", /Start session process/],
		["removed", /Start session process/],
	] as const)("an attached session that went %s leaves other rows startable", (how, item) => {
		const other = daemon("daemon-b", { status: "asleep" });
		dispatch({
			type: "roster",
			daemons: how === "removed" ? [other] : [daemon("daemon-a", { status: "asleep" }), other],
		});
		expect(connectionState()).toBe(how === "removed" ? "connected" : "offline");
		const menu = renderRowMenu(other);
		const button = menu.match(new RegExp(`<button[^>]*>(?:(?!</button>).)*${item.source}`))?.[0];
		expect(button).toBeDefined();
		expect(button).not.toMatch(/\bdisabled\b/);
	});

	test("a dropped /events stream still pauses row actions", () => {
		const other = daemon("daemon-b", { status: "asleep" });
		dispatch({ type: "roster", daemons: [daemon("daemon-a"), other] });
		setState("connected", false);
		const button = renderRowMenu(other).match(
			/<button[^>]*>(?:(?!<\/button>).)*Start session process/,
		)?.[0];
		expect(button).toMatch(/\bdisabled\b/);
	});
});
