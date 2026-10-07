import { createSignal, type Component } from "solid-js";
import { abortSubagent, pushNotice, steerSubagent, type SubagentInfo } from "../../state";
import { ConfirmButton } from "../shared/ConfirmButton";

/** Steer/abort controls for a running subagent row; hidden for finished/idle/parked agents. */
export const SubagentControls: Component<{ sub: SubagentInfo }> = (props) => {
	const [pending, setPending] = createSignal(false);
	const [aborting, setAborting] = createSignal(false);
	const [steerText, setSteerText] = createSignal("");

	const report = (err: unknown) =>
		pushNotice("error", err instanceof Error ? err.message : String(err));

	const steer = async (): Promise<void> => {
		const text = steerText().trim();
		if (!text || pending()) return;
		setPending(true);
		try {
			await steerSubagent(props.sub.id, text);
			setSteerText("");
		} catch (err) {
			report(err);
		} finally {
			setPending(false);
		}
	};

	const abort = async (): Promise<void> => {
		setAborting(true);
		setPending(true);
		try {
			await abortSubagent(props.sub.id);
		} catch (err) {
			report(err);
		} finally {
			setPending(false);
			setAborting(false);
		}
	};

	// The row itself opens the transcript; controls must not bubble to it.
	return (
		<div class="subagent-controls" onClick={(e) => e.stopPropagation()}>
			<input
				class="picker-filter"
				type="text"
				aria-label="Steer instructions"
				placeholder="steer…"
				value={steerText()}
				disabled={pending()}
				onInput={(e) => setSteerText(e.currentTarget.value)}
				onKeyDown={(e) => {
					if (e.key === "Enter") void steer();
				}}
			/>
			<button
				type="button"
				disabled={pending() || !steerText().trim()}
				onClick={() => void steer()}
			>
				steer
			</button>
			<ConfirmButton
				label={aborting() ? "aborting…" : "abort"}
				confirmLabel="confirm"
				disabled={pending()}
				onConfirm={() => void abort()}
			/>
		</div>
	);
};
