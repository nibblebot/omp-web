import { type Component, createEffect, createSignal, on, onCleanup, Show } from "solid-js";
import { unwrap } from "solid-js/store";
import { App } from "../web/App";
import { type ChatItem, setState, state } from "../web/state";
import { nextChatId, resetChatIds } from "../web/store/chat";
import { LAST_ROUTE_KEY } from "../web/store/deep-link";
import { formatRoute, parseRoute } from "../web/store/route";
import { settleAttachmentState } from "../web/store/transport";
import { answerCannedTurns, finishCannedTurn } from "./canned-turns";
import { answerDemoSession } from "./demo-session";
import { setInspecting } from "./inspect-runtime";
import { Inspector, clampInspectorWidth } from "./inspector";
import { Labels } from "./labels";
import { type AppSession, appSessions } from "./fixtures/app-sessions";
import { SCREEN_WORKSPACE_ID, screenSessionSeed } from "./fixtures/screen";
import { applySeeds } from "./seed";

/** Fresh transcript ids from the chat sequence, so live events never reuse a restored item's id. */
function renumber(items: ChatItem[]): ChatItem[] {
	resetChatIds();
	return items.map((item) => ({ ...item, id: nextChatId() }));
}

/** The attached session as the store holds it now, prompts sent in the page included. */
function captureSession(): AppSession {
	const s = unwrap(state);
	return structuredClone({
		view: {
			readyAt: s.readyAt,
			sessionId: s.sessionId,
			sessionName: s.sessionName,
			sessionFile: s.sessionFile,
			model: s.model,
			thinkingLevel: s.thinkingLevel,
			contextUsage: s.contextUsage,
			stats: s.stats,
			messageCount: s.messageCount,
			todoPhases: s.todoPhases,
		},
		items: s.items,
	});
}

/** The workspace the saved last route (`{ workspaceId, sessionId? }`) names, or null. */
function lastRouteWorkspace(): string | null {
	try {
		const saved: unknown = JSON.parse(localStorage.getItem(LAST_ROUTE_KEY) ?? "null");
		if (typeof saved !== "object" || saved === null || !("workspaceId" in saved)) return null;
		return typeof saved.workspaceId === "string" && saved.workspaceId !== ""
			? saved.workspaceId
			: null;
	} catch {
		return null;
	}
}

/**
 * The session the page opens on: the one the hash names, else the saved last
 * route's, else the screen session. Seeding it as attached lets the App's
 * initial route restore find it already attached instead of racing a switch
 * away from the screen session. A hash naming another session id than the
 * fixture's is rewritten to the fixture's (docks kept), so the restore does
 * not report it gone; an unknown workspace drops the hash and the saved route.
 */
function initialWorkspaceId(): string {
	const route = parseRoute(location.hash);
	let workspaceId: string | null = null;
	if (route.kind === "workspace" || route.kind === "session") workspaceId = route.workspaceId;
	else if (location.hash === "" || location.hash === "#") workspaceId = lastRouteWorkspace();
	if (workspaceId === null) return SCREEN_WORKSPACE_ID;
	const session = appSessions[workspaceId];
	const inRoster = screenSessionSeed.sessionRoster?.some((d) => d.workspaceId === workspaceId);
	if (session === undefined || !inRoster) {
		history.replaceState(history.state, "", location.pathname + location.search);
		localStorage.removeItem(LAST_ROUTE_KEY);
		return SCREEN_WORKSPACE_ID;
	}
	const sessionId = session.view.sessionId;
	if (route.kind === "session" && sessionId !== undefined && route.sessionId !== sessionId) {
		const hash = formatRoute({ ...route, sessionId });
		history.replaceState(history.state, "", location.pathname + location.search + hash);
	}
	return workspaceId;
}

/**
 * The App view (the demo page, `bun run demo`): the real `<App />` in Chat Mode, seeded with the screen
 * fixtures and answered by the fake session. Holding Shift labels the component
 * under the pointer and its ancestors, Ctrl+Shift every mounted component; a
 * label opens its component in the inspector sidebar.
 *
 * Clicking a sidebar row attaches like the real fleet: the command bus
 * (fixtures/command-bus.ts, over the fake socket) answers with `attached`, the store resets the
 * session view, and this view restores that session's transcript from
 * `appSessions` in place of the session's history priming. Every other call
 * and command is answered by demo-session.ts.
 *
 * Prompts get the canned turn (canned-turns.ts). Leaving a session plays its
 * running turn to the end and keeps its transcript for this page load, so
 * switching back shows what was sent there.
 */
export const AppView: Component = () => {
	// Track components created from here on, then seed before `<App />` renders.
	setInspecting(true);
	const initialId = initialWorkspaceId();
	const initial = appSessions[initialId]!;
	applySeeds({
		...screenSessionSeed,
		...initial.view,
		currentWorkspaceId: initialId,
		items: renumber(initial.items),
		streaming: false,
		transcriptPhase: "loaded",
		view: "chat",
	});
	answerCannedTurns();
	answerDemoSession();

	const visited = new Map<string, AppSession>();
	// `on`'s previous-input argument is unset on the first run after `defer`,
	// so the attached id is tracked here.
	let attached = state.currentWorkspaceId;
	createEffect(
		on(
			() => state.currentWorkspaceId,
			(id) => {
				// This runs as the `attached` handler switches the id, before it
				// resets the view: settle and save the session being left.
				const left = attached;
				attached = id;
				// A switch plays a running canned turn to its end (a no-op when
				// idle), as the session keeps working while nobody watches it;
				// only a real session is kept for switching back.
				finishCannedTurn();
				if (left !== "" && left !== id) visited.set(left, captureSession());
				if (id === "") return;
				const session = visited.get(id) ?? appSessions[id];
				// Restore once the handler's reset has run. It stands in for the session's
				// history priming and its first `state` frame, so it also ends the switch's
				// wait (loaded) and the attachment watches, even when there is no
				// transcript to restore. A workspace without one (created in the page)
				// opens as an empty, ready session.
				queueMicrotask(() => {
					if (state.currentWorkspaceId !== id) return;
					if (session !== undefined) {
						const { view, items } = structuredClone(session);
						setState({ ...view, items: renumber(items), streaming: false });
					} else {
						setState({
							readyAt: Date.now(),
							sessionId: `sess_${crypto.randomUUID().slice(0, 6)}`,
							sessionName: undefined,
							sessionFile: undefined,
							items: [],
							todoPhases: [],
							messageCount: 0,
							stats: null,
							contextUsage: {
								tokens: 0,
								contextWindow: state.model?.contextWindow ?? 200_000,
								percent: 0,
							},
							streaming: false,
						});
					}
					setState({ transcriptPhase: "loaded", transcriptError: null, transcriptTarget: null });
					settleAttachmentState();
				});
			},
			{ defer: true },
		),
	);

	const [selected, setSelected] = createSignal<string | null>(null);
	const [width, setWidth] = createSignal(clampInspectorWidth(window.innerWidth * 0.4));
	const [stageEl, setStageEl] = createSignal<HTMLElement>();

	createEffect(() => {
		document.body.style.setProperty(
			"--ds-inspector-w",
			selected() === null ? "0px" : `${width()}px`,
		);
	});

	onCleanup(() => {
		setInspecting(false);
		setSelected(null);
		document.body.style.removeProperty("--ds-inspector-w");
	});

	return (
		<div class="ds-app-view">
			<div class="ds-app-row">
				<div class="ds-app-stage" ref={(el) => setStageEl(el)}>
					<App />
				</div>
				<Show when={selected()} keyed>
					{(id) => (
						<Inspector
							id={id}
							width={width()}
							onWidth={(px) => setWidth(px)}
							onSelect={(id) => setSelected(id)}
							onClose={() => setSelected(null)}
						/>
					)}
				</Show>
			</div>
			<Labels stage={stageEl} onOpen={(id) => setSelected(id)} />
		</div>
	);
};
