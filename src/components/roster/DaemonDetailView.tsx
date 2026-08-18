import { For, Show, type Component } from "solid-js";
import type { DaemonEntry } from "../../../shared/protocol";
import { formatDaemonUptime } from "../../fleet-ui/daemon-ui";
import { DaemonLogView } from "./DaemonLogView";
import { Modal } from "../shared/Modal";
import { XIcon } from "../shared/icons";
import type { RosterEntry } from "./DaemonRow";

// ---------------------------------------------------------------------------
// Daemon detail popover: roster facts (cwd/mode/template/uptime/pid/session/
// labels/error) plus the live stderr tail. The log lifecycle (fetch/loading/
// error/tail/refresh) is the roster DaemonLogView primitive — the raw
// /ctl/sessions/{id}/stderr fetch now lives in state's fetchDaemonStderr.
// ---------------------------------------------------------------------------

export const DaemonDetailView: Component<{ daemon: DaemonEntry; onClose: () => void }> = (
	props,
) => {
	const d = () => props.daemon;
	// Live-process facts (uptime/pid) mean nothing once the daemon is asleep or
	// errored — and stale entries from older edges may still carry pid/readyAt
	// from the last run — so render them defensively off status, not field
	// presence. The roster entry's status is the single source of truth.
	const alive = () =>
		d().status === "ready" ||
		d().status === "connecting" ||
		d().status === "session" ||
		d().status === "resolving";
	return (
		<Modal class="daemon-detail" aria-label={`Daemon ${d().name}`} onClose={props.onClose}>
			<div class="daemon-detail-header">
				<span class="daemon-status-dot" data-status={d().status} title={d().status} />
				<span class="daemon-detail-name">{d().name}</span>
				<button
					type="button"
					class="daemon-detail-close"
					aria-label="Close daemon details"
					onClick={props.onClose}
				>
					<XIcon />
				</button>
			</div>
			<div class="daemon-detail-facts">
				<div class="daemon-detail-fact">
					<span class="daemon-detail-label">cwd</span>
					<span class="daemon-detail-value" title={d().cwd}>
						{d().cwd}
					</span>
				</div>
				<div class="daemon-detail-fact">
					<span class="daemon-detail-label">mode</span>
					<span class="daemon-detail-value">{d().mode}</span>
				</div>
				<Show when={(d() as RosterEntry).template}>
					{(name) => (
						<div class="daemon-detail-fact">
							<span class="daemon-detail-label">template</span>
							<span class="daemon-detail-value">{name()}</span>
						</div>
					)}
				</Show>
				<Show when={alive() && d().uptime !== undefined}>
					<div class="daemon-detail-fact">
						<span class="daemon-detail-label">uptime</span>
						<span class="daemon-detail-value">{formatDaemonUptime((d().uptime ?? 0) * 1000)}</span>
					</div>
				</Show>
				<Show when={alive() && d().pid !== undefined}>
					<div class="daemon-detail-fact">
						<span class="daemon-detail-label">pid</span>
						<span class="daemon-detail-value">{d().pid}</span>
					</div>
				</Show>
				<Show when={d().lastSessionFile}>
					{(file) => (
						<div class="daemon-detail-fact">
							<span class="daemon-detail-label">session</span>
							<span class="daemon-detail-value" title={file()}>
								{file()}
							</span>
						</div>
					)}
				</Show>
				<Show when={d().labels.length > 0}>
					<div class="daemon-detail-fact">
						<span class="daemon-detail-label">labels</span>
						<span class="daemon-detail-value daemon-detail-labels">
							<For each={d().labels}>
								{(l) => <span class="daemon-chip daemon-chip--label">{l}</span>}
							</For>
						</span>
					</div>
				</Show>
				<Show when={d().error}>
					{(err) => (
						<div class="daemon-detail-fact daemon-detail-fact--error">
							<span class="daemon-detail-label">error</span>
							<span class="daemon-detail-value">{err()}</span>
						</div>
					)}
				</Show>
			</div>
			<DaemonLogView daemonId={d().daemonId} />
		</Modal>
	);
};
