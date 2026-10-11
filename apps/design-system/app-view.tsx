import { type Component, createEffect, createSignal, on, onCleanup, Show } from "solid-js";
import { unwrap } from "solid-js/store";
import { App } from "../web/App";
import { type ChatItem, setState, state } from "../web/state";
import { nextChatId, resetChatIds } from "../web/store/chat";
import { settleDaemonSessions } from "../web/store/roster";
import { abortCannedTurn, answerCannedTurns } from "./canned-turns";
import { answerCommands } from "./daemon";
import { setInspecting } from "./inspect-runtime";
import { Inspector, clampInspectorWidth } from "./inspector";
import { Labels } from "./labels";
import { type AppSession, appDaemonSessions, appSessions } from "./fixtures/app-sessions";
import { screenItems, screenSessionSeed } from "./fixtures/screen";
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
		},
		items: s.items,
	});
}

/**
 * The App view (`/`): the real `<App />` in Chat Mode, seeded with the screen
 * fixtures and answered by the fake daemon. Holding Shift labels the component
 * under the pointer and its ancestors, Ctrl+Shift every mounted component; a
 * label opens its component in the inspector sidebar.
 *
 * Clicking a sidebar row attaches like the real fleet: the command bus
 * (fixtures/command-bus.ts) answers with `attached`, the store resets the
 * session view, and this view restores that daemon's transcript from
 * `appSessions` in place of the daemon's history priming. A row's session
 * dropdown lists that daemon's session, answered in the page (daemon.ts).
 *
 * Prompts get the canned turn (canned-turns.ts). Leaving a session ends its
 * running turn and keeps its transcript for this page load, so switching back
 * shows what was sent there.
 */
export const AppView: Component = () => {
	// Track components created from here on, then seed before `<App />` renders.
	setInspecting(true);
	applySeeds({
		...screenSessionSeed,
		items: renumber(screenItems),
		streaming: false,
		view: "chat",
	});
	answerCannedTurns();
	answerCommands({
		list_daemon_sessions: (cmd) => {
			if (cmd.type === "list_daemon_sessions")
				settleDaemonSessions(cmd.daemonId, appDaemonSessions(cmd.daemonId));
		},
	});

	const visited = new Map<string, AppSession>();
	// `on`'s previous-input argument is unset on the first run after `defer`,
	// so the attached id is tracked here.
	let attached = state.currentSessionId;
	createEffect(
		on(
			() => state.currentSessionId,
			(id) => {
				// This runs as the `attached` handler switches the id, before it
				// resets the view: settle and save the session being left.
				const left = attached;
				attached = id;
				if (left !== "" && left !== id) {
					abortCannedTurn();
					visited.set(left, captureSession());
				}
				const session = visited.get(id) ?? appSessions[id];
				if (session === undefined) return;
				// Restore once the handler's reset has run.
				queueMicrotask(() => {
					if (state.currentSessionId !== id) return;
					const { view, items } = structuredClone(session);
					setState({ ...view, items: renumber(items), streaming: false });
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
