import { createSignal, onCleanup, type JSX } from "solid-js";

/** Arming state for a two-click confirm (extracted from DaemonSidebar's
 *  armDaemon/disarmDaemon and SubagentPanel's confirm/cancel pair). The
 *  first click arms (the trigger relabels), a second click fires the action;
 *  auto-disarms after `timeoutMs` (default 4000 — DaemonSidebar's
 *  ARM_DISARM_MS) and on unmount. */
export interface ConfirmArm {
	armed: () => boolean;
	arm: () => void;
	disarm: () => void;
}

export function useConfirmArm(timeoutMs = 4000): ConfirmArm {
	const [armed, setArmed] = createSignal(false);
	let timer: ReturnType<typeof setTimeout> | undefined;
	const disarm = () => {
		clearTimeout(timer);
		timer = undefined;
		setArmed(false);
	};
	const arm = () => {
		clearTimeout(timer);
		setArmed(true);
		timer = setTimeout(disarm, timeoutMs);
	};
	onCleanup(disarm);
	return { armed, arm, disarm };
}

/** Two-click confirm button: first click arms + relabels, second fires
 *  `onConfirm`; auto-disarms after the arm timeout. Renders a plain
 *  `<button>` carrying `class`/`classList` (an `armed: true` flag is merged
 *  in for the armed state) so consumers keep their row/menu styling. */
export function ConfirmButton(props: {
	onConfirm: () => void;
	/** Unarmed label, e.g. "Stop daemon". */
	label: string;
	/** Armed relabel, e.g. "Confirm stop"; defaults to "Confirm". */
	confirmLabel?: string;
	disabled?: boolean;
	class?: string;
	classList?: Record<string, boolean | undefined>;
	title?: string;
	timeoutMs?: number;
	/** ARIA role override — pass "menuitem" inside a role="menu" dropdown. */
	role?: "button" | "menuitem";
	/** Optional leading content (e.g. a row-action icon) before the label. */
	children?: JSX.Element;
}): JSX.Element {
	const { armed, arm, disarm } = useConfirmArm(props.timeoutMs);
	return (
		<button
			type="button"
			role={props.role}
			class={props.class}
			classList={{ armed: armed(), ...props.classList }}
			disabled={props.disabled === true}
			title={props.title}
			onClick={() => {
				if (armed()) {
					disarm();
					props.onConfirm();
				} else {
					arm();
				}
			}}
		>
			{props.children}
			{armed() ? (props.confirmLabel ?? "Confirm") : props.label}
		</button>
	);
}
