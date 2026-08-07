import { createMemo, For, Match, Show, Switch, type Component } from "solid-js";
import type { LiveSessionEntry } from "../protocol";
import { attachSession, createSession, setSidebarVisible, setState, startCollab, state, stopCollab } from "../state";
import { CharacterAvatar } from "./CharacterAvatar";
import { CopyButton } from "./CopyButton";

/** Spawn a new live session (new server handle) and attach this tab to it. */
function spawnSession(): void {
	void createSession().catch(err => setState("error", String(err)));
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
								<span class="amount-bar amount-bar--sm">
									<span
										class="amount-bar-fill"
										style={{ width: `${Math.min(100, u().percent)}%` }}
									/>
								</span>
								<span class="amount-bar-pct" title={`${u().tokens} / ${u().contextWindow} tokens`}>
									{u().percent.toFixed(0)}%
								</span>
							</>
						)}
					</Show>
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
									<CopyButton class="sidebar-collab-copy" text={s().link} title="Copy `omp join` link" />
								</div>
								<div class="sidebar-collab-linkrow">
									<span class="sidebar-collab-label">view</span>
									<code class="sidebar-collab-link" title={s().viewLink}>
										{s().viewLink}
									</code>
									<CopyButton class="sidebar-collab-copy" text={s().viewLink} title="Copy read-only view link" />
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
			<span class="sidebar-stats">
				<Show when={state.processStats} fallback={<>{state.liveSessions.length} sessions</>}>
					{p => (
						<>
							{formatRss(p().rssBytes)} · up {formatUptime(p().uptimeSec)} · {p().sessionCount}{" "}
							sessions
						</>
					)}
				</Show>
			</span>
			<button class="sidebar-icon-btn" onClick={spawnSession} title="New session">
				+
			</button>
			<button class="sidebar-icon-btn" onClick={() => setSidebarVisible(false)} title="Hide sidebar">
				×
			</button>
		</div>
		<div class="sidebar-list">
			<For each={state.liveSessions}>{s => <SessionRow session={s} />}</For>
			<Show when={state.liveSessions.length === 0}>
				<div class="sidebar-empty">no live sessions</div>
			</Show>
		</div>
	</aside>
);
