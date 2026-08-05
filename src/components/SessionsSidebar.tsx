import { For, Show, type Component } from "solid-js";
import type { LiveSessionEntry } from "../protocol";
import { attachSession, createSession, setSidebarVisible, setState, state } from "../state";

/** Spawn a new live session (new server handle) and attach this tab to it. */
function spawnSession(): void {
	void createSession().catch(err => setState("error", String(err)));
}

/** Spawn 10 live sessions sequentially (create_session attaches each, so
 *  concurrent fires would churn the view); ends attached to the last one. */
function spawnTenSessions(): void {
	void (async () => {
		for (let i = 0; i < 10; i++) await createSession();
	})().catch(err => setState("error", String(err)));
}

function formatRss(bytes: number): string {
	return `${Math.round(bytes / 1024 / 1024)} MB`;
}

function formatUptime(sec: number): string {
	const m = Math.floor(sec / 60);
	if (m < 60) return `${m}m`;
	return `${Math.floor(m / 60)}h${m % 60}m`;
}

const SessionRow: Component<{ session: LiveSessionEntry }> = props => {
	const attach = () => void attachSession(props.session.sessionId).catch(() => {});
	return (
		<div
			class="sidebar-row"
			classList={{ active: props.session.sessionId === state.currentSessionId }}
			onClick={attach}
			title={props.session.cwd}
		>
			<div class="sidebar-row-top">
				<span class="sidebar-row-title">{props.session.name ?? props.session.sessionId}</span>
				<Show when={props.session.isStreaming}>
					<span class="sidebar-stream-dot" title="streaming" />
				</Show>
			</div>
			<div class="sidebar-row-meta">
				{props.session.model ?? "no model"}
				{props.session.thinkingLevel && props.session.thinkingLevel !== "inherit" && ` · ${props.session.thinkingLevel}`}
			</div>
			<Show when={props.session.contextUsage}>
				{u => (
					<div class="sidebar-ctx" title={`${u().tokens} / ${u().contextWindow} tokens`}>
						<div class="sidebar-ctx-bar">
							<div class="sidebar-ctx-fill" style={{ width: `${Math.min(100, u().percent)}%` }} />
						</div>
						<span class="sidebar-ctx-pct">{u().percent.toFixed(0)}%</span>
					</div>
				)}
			</Show>
		</div>
	);
};

/** Right-side column: server process stats + live-session roster (click to attach). */
export const SessionsSidebar: Component = () => (
	<aside class="sidebar">
		<div class="sidebar-header">
			<span class="sidebar-title">Sessions</span>
			<button class="sidebar-hide" onClick={spawnSession} title="New session">
				+
			</button>
			<button class="sidebar-hide" onClick={spawnTenSessions} title="Create 10 sessions">
				+10
			</button>
			<button class="sidebar-hide" onClick={() => setSidebarVisible(false)} title="Hide sidebar">
				×
			</button>
		</div>
		<div class="sidebar-stats">
			<Show when={state.processStats} fallback={<span>{state.liveSessions.length} sessions</span>}>
				{p => (
					<span>
						{formatRss(p().rssBytes)} · up {formatUptime(p().uptimeSec)} · {p().sessionCount} sessions
					</span>
				)}
			</Show>
		</div>
		<div class="sidebar-list">
			<For each={state.liveSessions}>{s => <SessionRow session={s} />}</For>
			<Show when={state.liveSessions.length === 0}>
				<div class="sidebar-empty">no live sessions</div>
			</Show>
		</div>
	</aside>
);
