import {
	createEffect,
	createMemo,
	createSignal,
	For,
	onCleanup,
	onMount,
	Show,
	type Component,
} from "solid-js";
import { call, sendLoginCode, setState, state } from "../../state";
import { isImeKey } from "../../prompt/key-input";
import { Modal } from "../ui/Modal";
import { groupProviders, type LoginProvider } from "./provider-login";

/**
 * Login surface: lists OAuth providers, hands a synchronously opened blank
 * tab the login URL when the relay unicast it (popup-blocker safe), and
 * collects manual codes for providers that prompt for one. Signed-in
 * providers are listed first and re-run the flow as "Re-login"; the filter
 * matches name or id.
 */
export const ProviderLoginDialog: Component<{ onClose: () => void }> = (props) => {
	const [providers, setProviders] = createSignal<LoginProvider[]>([]);
	const [query, setQuery] = createSignal("");
	const [error, setError] = createSignal<string | null>(null);
	const [inFlight, setInFlight] = createSignal<string | null>(null);
	const [code, setCode] = createSignal("");
	const groups = createMemo(() => groupProviders(providers(), query()));
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
			try {
				loginTab.location.href = loginUrl.launchUrl ?? loginUrl.url;
			} catch {
				// An installed (standalone) window can hand window.open to a browser
				// surface it cannot script; the "Open login page" link below remains.
			}
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

	const row = (p: LoginProvider) => (
		<div class="picker-row">
			<span class="picker-label">{p.name}</span>
			{p.authenticated && <span class="picker-detail">signed in</span>}
			<button
				style={{ "margin-left": "auto" }}
				disabled={!p.available || inFlight() !== null}
				onClick={() => login(p)}
			>
				{inFlight() === p.id ? "Logging in…" : p.authenticated ? "Re-login" : "Login"}
			</button>
		</div>
	);

	return (
		<Modal title="Login" onClose={props.onClose}>
			<Show when={error()}>{(msg) => <div class="msg-notice">{msg()}</div>}</Show>
			<input
				class="picker-filter"
				aria-label="Filter providers"
				placeholder="Filter providers"
				value={query()}
				onInput={(e) => setQuery(e.currentTarget.value)}
			/>
			<div class="picker-list">
				<Show when={groups().signedIn.length > 0}>
					<div class="picker-group-name">Signed in</div>
					<For each={groups().signedIn}>{row}</For>
				</Show>
				<Show when={groups().available.length > 0}>
					<div class="picker-group-name">Providers</div>
					<For each={groups().available}>{row}</For>
				</Show>
				<Show when={groups().signedIn.length + groups().available.length === 0}>
					<div class="picker-detail">No providers match “{query().trim()}”.</div>
				</Show>
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
					Login in progress. Closing this panel will not cancel the server-side flow. If the sign-in
					page opens elsewhere or cannot return here, use "Open login page" and paste the code it
					shows into the field that appears.
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
							autocomplete="off"
							autocapitalize="off"
							spellcheck={false}
							enterkeyhint="send"
							value={code()}
							onInput={(e) => setCode(e.currentTarget.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter" && !isImeKey(e)) submitCode();
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
