import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import {
	registerOAuthProvider,
	unregisterOAuthProvider,
	type OAuthProviderInterface,
} from "@oh-my-pi/pi-ai/oauth";
import { cleanupTempDirs, tempDir } from "#lib/testkit/temp-dir.testkit";
import type { ServerFrame } from "#lib/wire/protocol";
import { loginWithCallbacks } from "../login";
import { createWebMethods } from "../methods";
import type { SessionEntry } from "../session-entry";
import { detachConsumer, pendingCodeInputs, streams, type SseConsumer } from "../sse-delivery";

afterAll(cleanupTempDirs);

const PROVIDER = "omp-web-offline-login-test";
const CREDENTIAL_PROVIDER = `${PROVIDER}-credential`;
let store: SqliteAuthCredentialStore;
let auth: AuthStorage;
let dbPath: string;
let consumer: SseConsumer;
let received: ServerFrame[];
const entry = { handle: "s1" } as SessionEntry;

beforeEach(async () => {
	dbPath = join(tempDir("omp-login-"), "auth.db");
	store = await SqliteAuthCredentialStore.open(dbPath);
	auth = new AuthStorage(store);
	await auth.credentials.reload();
	received = [];
	consumer = {
		id: 9876,
		attached: "s1",
		unreadEstimate: 0,
		controller: {
			desiredSize: null,
			enqueue: (bytes: Uint8Array) => {
				const data = new TextDecoder()
					.decode(bytes)
					.split("\n")
					.find((line) => line.startsWith("data: "));
				if (data) received.push(JSON.parse(data.slice(6)));
			},
		} as ReadableStreamDefaultController<Uint8Array>,
	};
	streams.add(consumer);
});

afterEach(() => {
	detachConsumer(consumer, "test cleanup");
	unregisterOAuthProvider(PROVIDER);
	store.close();
});

function provider(login: OAuthProviderInterface["login"]): void {
	registerOAuthProvider({
		id: PROVIDER,
		name: "Offline login",
		storeCredentialsAs: CREDENTIAL_PROVIDER,
		login,
	});
}

describe("namespaced OAuth login through production SSE dialogs", () => {
	test("URL/code flow stores real credentials before refresh and reports effective auth for aliases", async () => {
		provider(async (callbacks) => {
			callbacks.onAuth({
				url: "https://example.invalid/auth",
				launchUrl: "http://localhost/auth",
				instructions: "Paste code",
			});
			const code = await callbacks.onPrompt({ message: "Authorization code", placeholder: "code" });
			if (code !== "valid-code") throw new Error("invalid authorization code");
			return {
				access: "offline-access",
				refresh: "offline-refresh",
				expires: Date.now() + 60_000,
				email: "test@example.invalid",
			};
		});
		const refreshed: string[] = [];
		const result = loginWithCallbacks(entry, PROVIDER, auth, async (id) => {
			expect(auth.credentials.hasOAuth(id)).toBe(true);
			refreshed.push(id);
		});
		const request = received.find((frame) => frame.type === "login_code_request");
		expect(request?.type).toBe("login_code_request");
		if (request?.type !== "login_code_request") throw new Error("missing code request");
		expect(received[0]).toMatchObject({
			type: "login_url",
			url: "https://example.invalid/auth",
			launchUrl: "http://localhost/auth",
			instructions: "Paste code",
		});
		const pending = pendingCodeInputs.get(request.requestId)!;
		pendingCodeInputs.delete(request.requestId);
		pending.resolve("valid-code");
		expect(await result).toEqual({ providerId: PROVIDER });
		expect(refreshed).toEqual([CREDENTIAL_PROVIDER]);
		expect(pendingCodeInputs.size).toBe(0);
		const reopenedStore = await SqliteAuthCredentialStore.open(dbPath);
		try {
			const reopened = new AuthStorage(reopenedStore);
			await reopened.credentials.reload();
			expect(reopened.credentials.getOAuth(CREDENTIAL_PROVIDER)?.email).toBe(
				"test@example.invalid",
			);
		} finally {
			reopenedStore.close();
		}
		const methods = createWebMethods({
			settings: {} as never,
			authStorage: auth,
			collab: {} as never,
			broker: {} as never,
			materializeSession: async () => ({ alreadyPresent: true }),
			sessionsDir: "",
			hasCallbackPair: () => false,
		}).methods;
		const providers = (await methods.getLoginProviders(entry, [])) as Array<{
			id: string;
			authenticated: boolean;
		}>;
		expect(providers.find((item) => item.id === PROVIDER)?.authenticated).toBe(true);
	});

	test("one disconnect leaves shared code prompt alive; the last owner cancels without storing auth", async () => {
		provider(async (callbacks) => {
			callbacks.onAuth({ url: "https://example.invalid/auth" });
			await callbacks.onPrompt({ message: "Code" });
			return {
				access: "must-not-be-stored",
				refresh: "must-not-be-stored",
				expires: Date.now() + 60_000,
			};
		});
		const second = { ...consumer, id: 9877 };
		streams.add(second);
		let refreshes = 0;
		const result = loginWithCallbacks(entry, PROVIDER, auth, async () => {
			refreshes++;
		});
		// Bun's rejection matchers wait synchronously; disconnect before asserting.
		const rejected = result.catch((error: unknown) => error);
		expect(pendingCodeInputs.size).toBe(1);
		detachConsumer(consumer, "first owner closed");
		expect(pendingCodeInputs.size).toBe(1);
		detachConsumer(second, "last owner closed");
		const error = await rejected;
		expect(error).toBeInstanceOf(Error);
		expect(error).toMatchObject({ message: "last owner closed" });
		expect(pendingCodeInputs.size).toBe(0);
		expect(auth.credentials.has(CREDENTIAL_PROVIDER)).toBe(false);
		expect(refreshes).toBe(0);
	});

	test.each([false, true])(
		"rejects unsupported initial/secret prompts (secret=%s) without success",
		async (secret) => {
			provider(async (callbacks) => {
				if (secret) callbacks.onAuth({ url: "https://example.invalid/auth" });
				await callbacks.onPrompt({ message: "Private input", secret });
				return {
					access: "must-not-be-stored",
					refresh: "must-not-be-stored",
					expires: Date.now() + 60_000,
				};
			});
			await expect(
				loginWithCallbacks(entry, PROVIDER, auth, async () => {
					throw new Error("must not refresh");
				}),
			).rejects.toThrow("not supported in the web UI");
			expect(pendingCodeInputs.size).toBe(0);
			expect(auth.credentials.has(CREDENTIAL_PROVIDER)).toBe(false);
		},
	);

	test("empty login result is not fake success and cannot refresh discovery", async () => {
		provider(async () => "");
		await expect(
			loginWithCallbacks(entry, PROVIDER, auth, async () => {
				throw new Error("must not refresh");
			}),
		).rejects.toThrow("did not store credentials");
		expect(auth.credentials.has(CREDENTIAL_PROVIDER)).toBe(false);
	});
});

test("login-provider auth availability includes runtime keys without claiming stored credentials", async () => {
	provider(async () => "");
	auth.keys.setRuntime(CREDENTIAL_PROVIDER, "runtime-key");
	expect(auth.credentials.has(CREDENTIAL_PROVIDER)).toBe(false);
	const methods = createWebMethods({
		settings: {} as never,
		authStorage: auth,
		collab: {} as never,
		broker: {} as never,
		materializeSession: async () => ({ alreadyPresent: true }),
		sessionsDir: "",
		hasCallbackPair: () => false,
	}).methods;
	const providers = (await methods.getLoginProviders(entry, [])) as Array<{
		id: string;
		authenticated: boolean;
	}>;
	expect(providers.find((item) => item.id === PROVIDER)?.authenticated).toBe(true);
});
