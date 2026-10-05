import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type { SessionEntry } from "./session-entry";
import { broadcastAnswer, notifyEvent, pendingCodeInputs, streams } from "./sse-delivery";

let nextLoginRequestId = 1;

/** The dispatch-time streams own pasted-code prompts until login settles. */
export async function loginWithCallbacks(
	entry: SessionEntry,
	providerId: string,
	authStorage: AuthStorage,
	onAuthenticated: (credentialProviderId: string) => Promise<void>,
): Promise<{ providerId: string }> {
	const provider = getOAuthProviders().find((candidate) => candidate.id === providerId);
	if (!provider) throw new Error(`Unknown OAuth provider: ${providerId}`);
	let authEmitted = false;
	const promptStreams = new Set(streams);
	try {
		const identity = await authStorage.oauth.login(provider.id, {
			onAuth: (info) => {
				authEmitted = true;
				broadcastAnswer({
					type: "login_url",
					url: info.url,
					launchUrl: info.launchUrl,
					instructions: info.instructions,
				});
			},
			onProgress: (message) => notifyEvent(entry, message),
			onPrompt: (prompt) => {
				if (!authEmitted || prompt.secret) {
					return Promise.reject(
						new Error(
							`Provider '${providerId}' requires interactive prompts ` +
								"which are not supported in the web UI. Use the terminal UI to log in.",
						),
					);
				}
				if (![...promptStreams].some((stream) => streams.has(stream))) {
					return Promise.reject(new Error("login streams closed"));
				}
				const requestId = `lr${nextLoginRequestId++}`;
				const { promise, resolve, reject } = Promise.withResolvers<string>();
				pendingCodeInputs.set(requestId, { streams: promptStreams, resolve, reject });
				broadcastAnswer({
					type: "login_code_request",
					requestId,
					title: prompt.message,
					placeholder: prompt.placeholder,
				});
				return promise;
			},
		});
		if (!identity) throw new Error(`Login did not store credentials for provider: ${providerId}`);
		await onAuthenticated(provider.storeCredentialsAs ?? providerId);
		return { providerId };
	} finally {
		for (const [id, pending] of pendingCodeInputs) {
			if (pending.streams === promptStreams) {
				pending.reject(new Error("login ended"));
				pendingCodeInputs.delete(id);
			}
		}
	}
}
