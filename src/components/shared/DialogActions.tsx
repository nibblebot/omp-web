import { Show, type JSX } from "solid-js";

/** Cancel+primary footer row, extracted from AskDialog's hand-rolled
 *  `.ask-actions` footers (AskForm/ConfirmForm/InputForm/EditorForm) and the
 *  DangerConfirmDialog danger variant — markup and classes verbatim. The
 *  primary button renders `.send` styling, or `.danger-confirm-btn` when
 *  `primaryDanger`. `onPrimary` is OPTIONAL: omit it for a cancel-only
 *  footer (SelectForm's case) with the same `.ask-actions` markup. `busy`
 *  disables both buttons while an async action settles. */
export function DialogActions(props: {
	onCancel: () => void;
	onPrimary?: () => void;
	primaryLabel?: string;
	cancelLabel?: string;
	primaryDisabled?: boolean;
	primaryDanger?: boolean;
	busy?: boolean;
}): JSX.Element {
	return (
		<div class="ask-actions">
			<Show when={props.onPrimary !== undefined}>
				<button
					type="button"
					classList={{
						send: props.primaryDanger !== true,
						"danger-confirm-btn": props.primaryDanger === true,
					}}
					disabled={props.busy === true || props.primaryDisabled === true}
					onClick={props.onPrimary}
				>
					{props.primaryLabel ?? "OK"}
				</button>
			</Show>
			<button type="button" disabled={props.busy === true} onClick={props.onCancel}>
				{props.cancelLabel ?? "Cancel"}
			</button>
		</div>
	);
}
