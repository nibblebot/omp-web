import { createSignal, Show, type Component } from "solid-js";
import { signIn } from "../store/auth";
import { Modal } from "./shared/Modal";
import { DialogActions } from "./shared/DialogActions";

/**
 * Sign-in surface for fleet browser auth (ledger "Browser auth"). The access
 * token lives ONLY in this component's signal and is posted exactly once to
 * POST /auth/login (src/store/auth.ts signIn); the server answers with the
 * HttpOnly `omp_session` cookie and the client keeps just the in-memory CSRF
 * token. Deliberately NO token persistence anywhere: not in
 * localStorage/sessionStorage, not in the URL.
 */
export const SignInModal: Component<{
	onClose: () => void;
	/** "expired" renders the session-expired notice (opened after a 401
	 *  bumped the auth store to signedOut mid-use); default "signin". */
	variant?: "signin" | "expired";
}> = (props) => {
	const [token, setToken] = createSignal("");
	const [error, setError] = createSignal<string | null>(null);
	const [inFlight, setInFlight] = createSignal(false);

	const submit = (): void => {
		const accessToken = token().trim();
		if (accessToken === "" || inFlight()) return;
		setInFlight(true);
		setError(null);
		signIn(accessToken)
			.then(() => props.onClose())
			.catch((err) => setError(err instanceof Error ? err.message : String(err)))
			.finally(() => setInFlight(false));
	};

	return (
		<Modal title="Sign in" onClose={props.onClose}>
			<Show when={props.variant === "expired"}>
				<div class="msg-notice">Your session has expired. Sign in again to continue.</div>
			</Show>
			<Show when={error()}>{(msg) => <div class="msg-notice">{msg()}</div>}</Show>
			<div class="settings-row">
				<span class="picker-label">Access token</span>
				<input
					class="picker-filter"
					type="password"
					autocomplete="current-password"
					aria-label="Access token"
					placeholder="Paste access token"
					value={token()}
					disabled={inFlight()}
					onInput={(e) => setToken(e.currentTarget.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") submit();
					}}
				/>
			</div>
			<p class="picker-note">
				Sessions last 30 days; the token is used once and never stored in this browser.
			</p>
			<DialogActions
				onCancel={props.onClose}
				onPrimary={submit}
				primaryLabel="Sign in"
				cancelLabel="Cancel"
				busy={inFlight()}
				primaryDisabled={token().trim() === ""}
			/>
		</Modal>
	);
};
