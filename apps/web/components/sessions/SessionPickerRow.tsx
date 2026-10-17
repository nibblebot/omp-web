import { Show, type Component } from "solid-js";
import {
	formatSessionAge,
	sessionDisplayTitle,
	sessionStatusLabel,
	sessionSubtitle,
	type SessionRow,
} from "../../store/session-list";
import { PickerRow } from "../ui/PickerRow";

/**
 * One session line in a SessionListPicker group: status dot, title, first-prompt
 * subtitle, message count and age, and an optional pin toggle. The attached session is shown
 * but disabled (it is never a resume target). Props only; no store imports.
 */
export const SessionPickerRow: Component<{
	row: SessionRow;
	active: boolean;
	showProject: boolean;
	nowMs: number;
	onActivate?: () => void;
	onChoose: () => void;
	onTogglePin?: () => void;
}> = (props) => {
	const statusLabel = () => sessionStatusLabel(props.row.status);
	return (
		<div
			class="picker-session-row"
			classList={{ active: props.active, current: props.row.current === true }}
		>
			<PickerRow
				class="session-row-main"
				classList={{ "session-row-pinned": props.row.pinned }}
				onMouseEnter={props.onActivate}
				onClick={props.onChoose}
				disabled={props.row.current === true}
				title={`${props.row.cwd || "(no directory)"}\n${props.row.id}`}
			>
				<span
					class={`session-status session-status-${props.row.status ?? "unknown"}`}
					role="img"
					aria-label={statusLabel()}
					title={statusLabel()}
				/>
				<span class="session-row-text">
					<span class="picker-label">{sessionDisplayTitle(props.row)}</span>
					<Show when={sessionSubtitle(props.row)}>
						{(subtitle) => <span class="session-row-sub">{subtitle()}</span>}
					</Show>
				</span>
				<span class="picker-meta">
					{props.row.messageCount} {props.row.messageCount === 1 ? "msg" : "msgs"} ·{" "}
					{formatSessionAge(props.row.modifiedMs, props.nowMs)}
					<Show when={props.showProject}> · {props.row.projectLabel}</Show>
				</span>
				<Show when={props.row.current}>
					<span class="picker-chip">current</span>
				</Show>
			</PickerRow>
			<Show when={props.onTogglePin !== undefined}>
				<button
					type="button"
					class="session-pin"
					aria-pressed={props.row.pinned}
					aria-label={`${props.row.pinned ? "Unpin" : "Pin"} ${sessionDisplayTitle(props.row)}`}
					title={
						props.row.pinned
							? "Unpin: remove from the top of the list"
							: "Pin: keep at the top of the list"
					}
					onClick={() => props.onTogglePin?.()}
				>
					{props.row.pinned ? "★" : "☆"}
				</button>
			</Show>
		</div>
	);
};
