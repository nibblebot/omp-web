import { createSignal } from "solid-js";

// Danger-confirm dialog state (P1 hardening): replaces the native
// window.confirm guards on /new, /drop, and /fresh with the app's own Modal
// chrome. The dialog self-mounts (rendered once from App.tsx, like
// AskDialog/BtwPanel) and renders nothing while no confirm is pending. State
// and actions live here — free of solid-js/web and of any component file —
// so pure modules (commands.ts, commands.test.ts) can drive the confirm
// without pulling Portal into their import graph.

export type DangerConfirmOpts = {
	title: string;
	body: string;
	confirmLabel: string;
	onConfirm: () => void;
};

// The copy rides a module-level signal; the pending action rides a plain
// `let` BESIDE it — never inside the signal or a store (signals proxy
// objects, and the closure must not be serialized). Calling
// requestDangerConfirm replaces any pending confirm; the stale action is
// dropped with it.
const [pending, setPending] = createSignal<{
	title: string;
	body: string;
	confirmLabel: string;
} | null>(null);
let pendingAction: (() => void) | undefined;

/** Open the danger confirm; a pending confirm is replaced, not stacked. */
export function requestDangerConfirm(opts: DangerConfirmOpts): void {
	pendingAction = opts.onConfirm;
	setPending({ title: opts.title, body: opts.body, confirmLabel: opts.confirmLabel });
}

/** Close without running the pending action (Cancel/Esc/backdrop; tests). */
export function cancelDangerConfirm(): void {
	pendingAction = undefined;
	setPending(null);
}

/** Read accessor for render and tests. */
export function dangerConfirm(): { title: string; body: string; confirmLabel: string } | null {
	return pending();
}

/** Run the pending action, then close — the dialog button's handler. */
export function confirmDangerConfirm(): void {
	const action = pendingAction;
	action?.();
	cancelDangerConfirm();
}
