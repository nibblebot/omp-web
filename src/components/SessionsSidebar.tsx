import { createMemo, createSignal, For, Match, Show, Switch, type Component } from "solid-js";
import type { LiveSessionEntry } from "../protocol";
import { attachSession, createSession, setSidebarVisible, setState, startCollab, state, stopCollab } from "../state";
import { CharacterAvatar } from "./CharacterAvatar";
import { copyText } from "./Markdown";

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

/** Small copy button with a transient "copied" label (clipboard + textarea fallback). */
const CollabCopyButton: Component<{ text: string; title?: string }> = props => {
	const [copied, setCopied] = createSignal(false);
	return (
		<button
			class="sidebar-collab-copy"
			type="button"
			title={props.title}
			onClick={e => {
				e.stopPropagation();
				void copyText(props.text).then(ok => {
					setCopied(ok);
					setTimeout(() => setCopied(false), 1200);
				});
			}}
		>
			{copied() ? "copied" : "copy"}
		</button>
	);
};

const SessionRow: Component<{ session: LiveSessionEntry }> = props => {
	const attach = () => void attachSession(props.session.sessionId).catch(() => {});
	const isAttached = () => props.session.sessionId === state.currentSessionId;
	return (
		<div
			class="sidebar-row"
			classList={{ active: isAttached() }}
			onClick={attach}
			title={props.session.cwd}
		>
			<CharacterAvatar size={16} provider={props.session.model?.split("/")[0]} />
			<div class="sidebar-row-main">
				<div class="sidebar-row-top">
					<span class="sidebar-row-title">{props.session.name ?? props.session.sessionId}</span>
					<Show when={props.session.isStreaming}>
						<span class="sidebar-stream-dot" title="streaming" />
					</Show>
				</div>
				<div class="sidebar-row-data">
					<Show when={props.session.contextUsage}>
						{u => (
							<>
								<span class="sidebar-ctx-bar">
									<span
										class="sidebar-ctx-fill"
										style={{ width: `${Math.min(100, u().percent)}%` }}
									/>
								</span>
								<span class="sidebar-ctx-pct" title={`${u().tokens} / ${u().contextWindow} tokens`}>
									{u().percent.toFixed(0)}%
								</span>
								<span class="sidebar-data-sep">·</span>
							</>
						)}
					</Show>
					<span class="sidebar-sub-count" title="subagents (placeholder)">
						0 sub
					</span>
				</div>
			</div>
			{/* Collab controls: only on the attached session's row (collab_start/
			    collab_stop target the attached session). */}
			<Show when={isAttached()}>
				<Switch>
					<Match when={state.collabStatus.state === "off"}>
						<div class="sidebar-collab-row">
							<button
								class="sidebar-collab-btn"
								type="button"
								title="Start collab — TUI clients can `omp join` this session"
								onClick={e => {
									e.stopPropagation();
									startCollab();
								}}
							>
								share
							</button>
						</div>
					</Match>
					<Match when={state.collabStatus.state === "starting"}>
						<div class="sidebar-collab-row">
							<span class="sidebar-collab-muted">collab starting…</span>
						</div>
					</Match>
					<Match when={state.collabStatus.state === "error" ? state.collabStatus : false}>
						{s => (
							<div class="sidebar-collab-error">
								<span class="sidebar-collab-errtext" title={s().error}>
									{s().error}
								</span>
								<button
									class="sidebar-collab-btn"
									type="button"
									title="Retry starting collab"
									onClick={e => {
										e.stopPropagation();
										startCollab();
									}}
								>
									share
								</button>
							</div>
						)}
					</Match>
				</Switch>
				<Show when={state.collabStatus.state === "live" ? state.collabStatus : false}>
					{s => {
						// Memo, not a plain const: Show re-runs its child only when
						// the when-value flips truthiness, so derived values must
						// track s() themselves to follow later collab_status frames.
						const guests = createMemo(() => s().participants.filter(p => p.role === "guest").length);
						return (
							<div class="sidebar-collab">
								<div class="sidebar-collab-head">
									<span class="sidebar-collab-live">collab live</span>
									<span class="sidebar-collab-guests">
										{guests()} guest{guests() === 1 ? "" : "s"}
									</span>
									<button
										class="sidebar-collab-btn sidebar-collab-stop"
										type="button"
										title="Stop collab and close the room"
										onClick={e => {
											e.stopPropagation();
											stopCollab();
										}}
									>
										stop
									</button>
								</div>
								<div class="sidebar-collab-linkrow">
									<span class="sidebar-collab-label">join</span>
									<code class="sidebar-collab-link" title={s().link}>
										{s().link}
									</code>
									<CollabCopyButton text={s().link} title="Copy `omp join` link" />
								</div>
								<div class="sidebar-collab-linkrow">
									<span class="sidebar-collab-label">view</span>
									<code class="sidebar-collab-link" title={s().viewLink}>
										{s().viewLink}
									</code>
									<CollabCopyButton text={s().viewLink} title="Copy read-only view link" />
								</div>
								<ul class="sidebar-collab-list">
									<For each={s().participants}>
										{p => (
											<li>
												<span class="sidebar-collab-name">{p.name}</span>
												{p.role === "guest" && p.readOnly ? (
													<span class="sidebar-collab-ro">read-only</span>
												) : null}
											</li>
										)}
									</For>
								</ul>
							</div>
						);
					}}
				</Show>
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
