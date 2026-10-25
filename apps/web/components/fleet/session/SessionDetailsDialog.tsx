import { Show, type Component } from "solid-js";
import type { RosterEntry } from "#lib/wire/protocol";
import { formatDaemonUptime } from "../../../fleet-ui/session-ui";
import { SessionLog } from "./SessionLog";
import { Modal } from "../../ui/Modal";
import type { DetailedRosterEntry } from "../sidebar/WorkspaceRow";

// ---------------------------------------------------------------------------
// Session detail popover: roster facts (cwd/mode/template/uptime/pid/session/
// error) plus the live stderr tail. The log lifecycle (fetch/loading/
// error/tail/refresh) is the roster's SessionLog component; the raw
// /ctl/sessions/{id}/stderr fetch now lives in state's fetchSessionStderr.
// ---------------------------------------------------------------------------

export const SessionDetailsDialog: Component<{ session: RosterEntry; onClose: () => void }> = (
	props,
) => {
	const d = () => props.session;
	// Live-process facts (uptime/pid) mean nothing once the session is asleep or
	// errored, and such an entry may still carry pid/readyAt from the last run,
	// so render them defensively off status, not field presence. The roster
	// entry's status is the single source of truth.
	const alive = () =>
		d().status === "ready" || d().status === "connecting" || d().status === "resolving";
	return (
		<Modal
			class="session-detail"
			ariaLabel={`Session process ${d().name}`}
			onClose={props.onClose}
			header={
				<>
					<span class="session-status-dot" data-status={d().status} title={d().status} />
					<span class="session-detail-name">{d().name}</span>
				</>
			}
		>
			<div class="session-detail-facts">
				<div class="session-detail-fact">
					<span class="session-detail-label">cwd</span>
					<span class="session-detail-value" title={d().cwd}>
						{d().cwd}
					</span>
				</div>
				<Show when={(d() as DetailedRosterEntry).template}>
					{(name) => (
						<div class="session-detail-fact">
							<span class="session-detail-label">template</span>
							<span class="session-detail-value">{name()}</span>
						</div>
					)}
				</Show>
				<Show when={alive() && d().uptime !== undefined}>
					<div class="session-detail-fact">
						<span class="session-detail-label">uptime</span>
						<span class="session-detail-value">{formatDaemonUptime((d().uptime ?? 0) * 1000)}</span>
					</div>
				</Show>
				<Show when={alive() && d().pid !== undefined}>
					<div class="session-detail-fact">
						<span class="session-detail-label">pid</span>
						<span class="session-detail-value">{d().pid}</span>
					</div>
				</Show>
				<Show when={d().lastSessionFile}>
					{(file) => (
						<div class="session-detail-fact">
							<span class="session-detail-label">session</span>
							<span class="session-detail-value" title={file()}>
								{file()}
							</span>
						</div>
					)}
				</Show>
				<Show when={d().error}>
					{(err) => (
						<div class="session-detail-fact session-detail-fact--error">
							<span class="session-detail-label">error</span>
							<span class="session-detail-value">{err()}</span>
						</div>
					)}
				</Show>
			</div>
			<SessionLog workspaceId={d().workspaceId} />
		</Modal>
	);
};
