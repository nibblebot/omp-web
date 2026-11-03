import { Show, type Component } from "solid-js";
import {
	formatSessionAge,
	sessionDisplayTitle,
	sessionStatusLabel,
	type SessionRow,
	type SessionStatus,
} from "../../store/session-list";

/** Outcomes worth a dot; a finished or unknown session shows none. */
const ABNORMAL_STATUS: Readonly<Partial<Record<SessionStatus, true>>> = {
	error: true,
	interrupted: true,
	aborted: true,
	pending: true,
};

/**
 * One session as a single left-aligned line: status dot (abnormal outcomes only),
 * title, pin glyph, `empty` tag, optional project, and a right-aligned age. The
 * attached session is accent-coloured; a blocked row explains why, with an optional Add
 * project action. A click resumes, so both are disabled, unless `selects` makes the
 * click a selection (full lists, where resume is a separate action). `compact` is the
 * tight density for the sidebar and empty screen (callers filter empty sessions out
 * there). A `partial` row (only its indexed title and age are known) hides the `empty` tag and
 * the project label, and shows no folder. Props only; no store imports.
 */
export const SessionPickerRow: Component<{
	row: SessionRow;
	size: "full" | "compact";
	/** Keyboard or pointer highlight; with `selects`, the selected row. */
	active?: boolean;
	/** Append the project label (the "All projects" scope). */
	showProject?: boolean;
	nowMs: number;
	/** Mouse enter: lets a list move its highlight with the pointer. */
	onActivate?: () => void;
	/** Click: resume this session, or select it when `selects` is set. */
	onChoose: () => void;
	/** The click selects the row instead of resuming it, so attached and blocked rows stay clickable. */
	selects?: boolean;
	/** Opens Add project for a blocked row (no registered project owns its folder). */
	onAddProject?: () => void;
}> = (props) => {
	const dotStatus = () => {
		const status = props.row.status;
		return status !== undefined && ABNORMAL_STATUS[status] === true ? status : undefined;
	};
	const title = () => sessionDisplayTitle(props.row);
	return (
		<div
			class="session-pick"
			data-size={props.size}
			classList={{
				active: props.active === true,
				current: props.row.current === true,
				blocked: props.row.blocked !== undefined,
			}}
		>
			<div class="session-pick-line">
				<button
					type="button"
					class="session-pick-main"
					onMouseEnter={() => props.onActivate?.()}
					onClick={() => props.onChoose()}
					disabled={
						props.selects !== true &&
						(props.row.current === true || props.row.blocked !== undefined)
					}
					aria-expanded={props.selects === true ? props.active === true : undefined}
					title={[
						title(),
						props.row.partial === true ? "" : props.row.cwd || "(no directory)",
						props.row.id,
					]
						.filter((line) => line !== "")
						.join("\n")}
				>
					<Show when={dotStatus()}>
						{(status) => (
							<span
								class="session-pick-dot"
								data-status={status()}
								role="img"
								aria-label={sessionStatusLabel(status())}
								title={sessionStatusLabel(status())}
							/>
						)}
					</Show>
					<span class="session-pick-title">{title()}</span>
					<Show when={props.row.pinned}>
						<span class="session-pick-pin" role="img" aria-label="Pinned" title="Pinned">
							★
						</span>
					</Show>
					<Show
						when={
							props.size === "full" && props.row.messageCount === 0 && props.row.partial !== true
						}
					>
						<span class="session-pick-tag">empty</span>
					</Show>
					<Show when={props.row.current}>
						<span class="session-pick-current">current</span>
					</Show>
					<Show when={props.showProject && props.row.partial !== true}>
						<span class="session-pick-project">{props.row.projectLabel}</span>
					</Show>
					<span class="session-pick-age">
						{formatSessionAge(props.row.modifiedMs, props.nowMs)}
					</span>
				</button>
				<Show when={props.row.blocked !== undefined && props.onAddProject !== undefined}>
					<button type="button" class="session-pick-add" onClick={() => props.onAddProject?.()}>
						Add project
					</button>
				</Show>
			</div>
			<Show when={props.row.blocked}>
				{(blocked) => <div class="session-pick-blocked">{blocked().reason}</div>}
			</Show>
		</div>
	);
};
