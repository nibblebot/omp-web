import {
	createEffect,
	createSignal,
	For,
	onCleanup,
	onMount,
	Show,
	type Component,
} from "solid-js";
import { call, sendLoginCode, setState, state } from "../../state";
import { Modal } from "../shared/Modal";

type LoginProvider = { id: string; name: string; available: boolean; authenticated: boolean };

/**
 * Login surface: lists OAuth providers, hands a synchronously opened blank
 * tab the login URL when the relay unicast it (popup-blocker safe), and
 * collects manual codes for providers that prompt for one.
 */
export const LoginModal: Component<{ onClose: () => void }> = (props) => {
	const [providers, setProviders] = createSignal<LoginProvider[]>([]);
	const [error, setError] = createSignal<string | null>(null);
	const [inFlight, setInFlight] = createSignal<string | null>(null);
	const [code, setCode] = createSignal("");
	// Blank tab opened synchronously in the click handler; the loginUrl effect
	// below navigates it once the relay provides the URL.
	let loginTab: Window | null = null;

	const fetchProviders = (): Promise<void> =>
		call("getLoginProviders")
			.then((list) => {
				setProviders(list as LoginProvider[]);
			})
			.catch((err) => {
				setError(String(err));
			});

	onMount(() => {
		void fetchProviders();
	});

	onCleanup(() => {
		// Closing mid-login: shut the blank OAuth tab. The server-side login
		// itself has no cancel path and may continue to completion.
		loginTab?.close();
		setState("loginUrl", null);
		setState("loginCodeRequest", null);
	});

	createEffect(() => {
		const loginUrl = state.loginUrl;
		if (loginUrl && loginTab && !loginTab.closed) {
			loginTab.location.href = loginUrl.launchUrl ?? loginUrl.url;
		}
	});

	const login = (p: LoginProvider) => {
		if (inFlight() !== null) return; // one OAuth flow at a time; tab ref is shared
		setError(null);
		// MUST stay synchronous with the click or the popup gets blocked.
		loginTab = window.open("", "_blank");
		if (loginTab) loginTab.opener = null; // OAuth page must not reach back
		setInFlight(p.id);
		void call("login", [p.id], 0)
			.then(() => fetchProviders())
			.catch((err) => setError(String(err)))
			.finally(() => {
				setState("loginUrl", null);
				setState("loginCodeRequest", null);
				setInFlight(null);
				loginTab = null;
			});
	};

	const submitCode = () => {
		const req = state.loginCodeRequest;
		const value = code().trim();
		if (!req || value === "") return;
		try {
			sendLoginCode(req.requestId, value);
			setCode("");
		} catch (err) {
			setError(String(err));
		}
	};

	return (
		<Modal title="Login" onClose={props.onClose}>
			<Show when={error()}>{(msg) => <div class="msg-notice">{msg()}</div>}</Show>
			<div class="picker-list">
				<For each={providers()}>
					{(p) => (
						<div class="picker-row">
							<span class="picker-label">{p.name}</span>
							{p.authenticated && <span class="picker-detail">authenticated</span>}
							<button
								style={{ "margin-left": "auto" }}
								disabled={!p.available || inFlight() !== null}
								onClick={() => login(p)}
							>
								{inFlight() === p.id ? "Logging in…" : "Login"}
							</button>
						</div>
					)}
				</For>
			</div>
			<Show when={state.loginUrl}>
				{(loginUrl) => (
					<div class="msg-notice">
						<a href={loginUrl().launchUrl ?? loginUrl().url} target="_blank" rel="noreferrer">
							Open login page
						</a>
						{loginUrl().instructions && <div>{loginUrl().instructions}</div>}
					</div>
				)}
			</Show>
			<Show when={inFlight() !== null}>
				<div class="msg-notice">
					Login in progress — closing this panel will not cancel the server-side flow.
				</div>
			</Show>
			<Show when={state.loginCodeRequest}>
				{(req) => (
					<div class="settings-row">
						<span class="picker-label">{req().title}</span>
						<input
							class="picker-filter"
							aria-label={req().title}
							placeholder={req().placeholder ?? ""}
							value={code()}
							onInput={(e) => setCode(e.currentTarget.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") submitCode();
							}}
						/>
						<button disabled={code().trim() === ""} onClick={submitCode}>
							Submit
						</button>
					</div>
				)}
			</Show>
		</Modal>
	);
};
