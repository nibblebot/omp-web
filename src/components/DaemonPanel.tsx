import { createEffect, createSignal, Show, untrack, type Component } from "solid-js";
import type { DaemonInfo } from "../../shared/protocol";
import { requestDaemonLogs, restartDaemon, stopDaemon } from "../state";
import { DAEMON_GLYPH, formatDaemonUptime } from "./ActiveDaemons";
import { Modal } from "./Modal";

// Non-terminal daemon states (matches the server's port-resolution gate):
// the declared ready port is only meaningful while the process could be up.
const NON_TERMINAL_DAEMON_STATES: Record<string, true> = {
	starting: true,
	running: true,
	ready: true,
	restarting: true,
};

const LOG_LINES = 200;

/**
 * Per-daemon detail panel: declared ready-port link, log viewer
 * (requestDaemonLogs), restart + two-click-confirm stop. Esc/backdrop close
 * through the shared Modal; no proxy — the link is the raw loopback shortcut.
 */
export const DaemonPanel: Component<{ daemon: DaemonInfo; daemonKey: string; onClose: () => void }> = props => {
	const [logText, setLogText] = createSignal("");
	const [logError, setLogError] = createSignal<string | null>(null);
	const [logsLoading, setLogsLoading] = createSignal(false);
	const [tail, setTail] = createSignal(true);
	const [controlBusy, setControlBusy] = createSignal<"restart" | "stop" | null>(null);
	const [controlError, setControlError] = createSignal<string | null>(null);
	const [confirmStop, setConfirmStop] = createSignal(false);

	const d = () => props.daemon;

	const linkUrl = () => {
		const daemon = d();
		if (daemon.readyPort === undefined || !NON_TERMINAL_DAEMON_STATES[daemon.state]) return null;
		return `http://${daemon.readyHost ?? "127.0.0.1"}:${daemon.readyPort}`;
	};

	const loadLogs = (head: boolean) => {
		setLogsLoading(true);
		setLogError(null);
		// untrack: the daemon object is replaced every roster tick; reading it
		// here must not turn the roster broadcast into a log-refetch dependency.
		const daemon = untrack(d);
		requestDaemonLogs(daemon.projectDir, daemon.name, { lines: LOG_LINES, head })
			.then(result => setLogText(result.text))
			.catch(err => setLogError(String(err)))
			.finally(() => setLogsLoading(false));
	};

	// Reload only when the SHOWN daemon changes (daemonKey — a stable identity
	// string, unlike props.daemon which is a fresh object per roster broadcast)
	// or the tail/head toggle flips. The panel is NOT remounted when strip
	// selection moves between daemons, so mount-only loading would show the
	// previous daemon's logs.
	createEffect(() => {
		void props.daemonKey;
		loadLogs(!tail());
	});

	const doRestart = () => {
		setControlBusy("restart");
		setControlError(null);
		const daemon = d();
		restartDaemon(daemon.projectDir, daemon.name)
			.then(() => loadLogs(!tail()))
			.catch(err => setControlError(String(err)))
			.finally(() => setControlBusy(null));
	};

	const doStop = () => {
		setControlBusy("stop");
		setControlError(null);
		const daemon = d();
		stopDaemon(daemon.projectDir, daemon.name)
			.catch(err => setControlError(String(err)))
			.finally(() => {
				setControlBusy(null);
				setConfirmStop(false);
			});
	};

	return (
		<Modal class="daemon-panel" aria-label={`Daemon ${d().name}`} onClose={props.onClose}>
			<div class="daemon-panel-header">
				<span class="daemon-glyph" data-state={d().state}>
					{DAEMON_GLYPH[d().state] ?? "◐"}
				</span>
				<span class="daemon-name">{d().name}</span>
				<span class="daemon-state">{d().state}</span>
				<button type="button" class="daemon-panel-close" aria-label="Close daemon panel" onClick={props.onClose}>
					×
				</button>
			</div>
			<div class="daemon-facts">
				<span class="daemon-fact">
					<span class="daemon-fact-label">dir</span>
					{d().projectDir}
				</span>
				<Show when={d().pid !== undefined}>
					<span class="daemon-fact">
						<span class="daemon-fact-label">pid</span>
						{d().pid}
					</span>
				</Show>
				<span class="daemon-fact">
					<span class="daemon-fact-label">uptime</span>
					{formatDaemonUptime(Date.now() - d().startedAt)}
				</span>
				<Show when={d().restartCount > 0}>
					<span class="daemon-fact">
						<span class="daemon-fact-label">restarts</span>
						{d().restartCount}
					</span>
				</Show>
			</div>
			<Show when={linkUrl()}>
				{url => (
					<a class="daemon-link-chip" href={url()} target="_blank" rel="noreferrer" title="declared port">
						{url()}
					</a>
				)}
			</Show>
			<div class="daemon-log-head">
				<span class="daemon-log-title">logs</span>
				<label class="daemon-tail-toggle">
					<input type="checkbox" checked={tail()} onChange={e => setTail(e.currentTarget.checked)} />
					tail
				</label>
				<button type="button" disabled={logsLoading()} onClick={() => void loadLogs(!tail())}>
					{logsLoading() ? "loading…" : "refresh"}
				</button>
			</div>
			<Show when={logError()}>{err => <div class="msg-notice daemon-log-error">{err()}</div>}</Show>
			<Show when={logError() === null}>
				<Show
					when={logText() !== ""}
					fallback={<div class="daemon-log-empty">{logsLoading() ? "loading logs…" : "no output"}</div>}
				>
					<pre class="daemon-log">{logText()}</pre>
				</Show>
			</Show>
			<Show when={controlError()}>{err => <div class="msg-notice daemon-control-error">{err()}</div>}</Show>
			<div class="daemon-control-row">
				<button type="button" disabled={controlBusy() !== null} onClick={() => void doRestart()}>
					{controlBusy() === "restart" ? "restarting…" : "restart"}
				</button>
				<Show
					when={confirmStop()}
					fallback={
						<button type="button" class="danger" disabled={controlBusy() !== null} onClick={() => setConfirmStop(true)}>
							stop
						</button>
					}
				>
					<button type="button" class="danger" disabled={controlBusy() !== null} onClick={() => void doStop()}>
						{controlBusy() === "stop" ? "stopping…" : "confirm stop?"}
					</button>
					<button type="button" disabled={controlBusy() !== null} onClick={() => setConfirmStop(false)}>
						cancel
					</button>
				</Show>
			</div>
		</Modal>
	);
};
