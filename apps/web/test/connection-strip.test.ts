/**
 * Killing the attached session process: roster truth (asleep/error, or the
 * entry gone) moves the view to "offline", the connection strip renders with
 * the offline state, and session-bound actions render disabled.
 *
 * Store path: a roster frame drives reconcileAttachedSession, which sets
 * sessionDownId and clears currentSessionId. Component path: ConnectionBar,
 * SessionTitle (New session) and PromptActions (Send) render through solid's
 * SSR runtime (see the shared JSX shim).
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import * as solidWeb from "solid-js/web";
import type { DaemonEntry, ServerFrame } from "#lib/wire/protocol";
import { ConnectionBar } from "../components/app/ConnectionBar";
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

describe("killed attached session process", () => {
	test("while the session is attached and ready, the strip is hidden and actions are enabled", () => {
		expect(connectionState()).toBe("connected");
		const { strip, title, actions } = renderChrome();
		expect(strip).not.toContain("connection-bar");
		expect(title).not.toMatch(/<button[^>]*disabled[^>]*aria-label="New session"/);
		expect(title).toMatch(/<button[^>]*aria-label="New session"/);
		expect(actions).not.toMatch(/<button[^>]*disabled[^>]*>Send</);
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
			expect(actions).toMatch(/<button[^>]*disabled[^>]*>Send</);
		},
	);

	test("a removed roster entry is also offline, not a silent empty pane", () => {
		dispatch({ type: "roster", daemons: [] });
		expect(state.sessionDownId).toBe("daemon-a");
		expect(connectionState()).toBe("offline");
		expect(renderChrome().strip).toContain('data-state="offline"');
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
});
