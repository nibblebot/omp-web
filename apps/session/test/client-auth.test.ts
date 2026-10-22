import { describe, expect, test } from "bun:test";
import type { BrowserSocketParams } from "#lib/wire/browser-socket";
import { OMP_PROTO } from "#lib/wire/protocol";
import {
	bearerHeaderOk,
	httpAuthorized,
	socketRefusal,
	tokenOk,
	type ClientCredentials,
} from "../client-auth";

const TOKEN = "sekret";

function credentials(overrides: Partial<ClientCredentials> = {}): ClientCredentials {
	return { loopback: false, token: TOKEN, authorization: null, browserAllowed: true, ...overrides };
}

function params(overrides: Partial<BrowserSocketParams> = {}): BrowserSocketParams {
	return { clientId: null, after: null, proto: OMP_PROTO, token: null, ...overrides };
}

describe("token comparison", () => {
	test("the token must match exactly; case and length differences refuse", () => {
		expect(tokenOk(TOKEN, TOKEN)).toBe(true);
		expect(tokenOk("SEKRET", TOKEN)).toBe(false);
		expect(tokenOk("sekret ", TOKEN)).toBe(false);
		expect(tokenOk("", TOKEN)).toBe(false);
	});

	test("the Authorization scheme is case-insensitive, the token is not", () => {
		expect(bearerHeaderOk("Bearer sekret", TOKEN)).toBe(true);
		expect(bearerHeaderOk("bearer sekret", TOKEN)).toBe(true);
		expect(bearerHeaderOk("Bearer SEKRET", TOKEN)).toBe(false);
		expect(bearerHeaderOk("Basic sekret", TOKEN)).toBe(false);
		expect(bearerHeaderOk(null, TOKEN)).toBe(false);
	});
});

describe("plain HTTP routes", () => {
	test("loopback is exempt; off-loopback needs the bearer header; no token configured means open", () => {
		expect(httpAuthorized(credentials({ loopback: true }))).toBe(true);
		expect(httpAuthorized(credentials())).toBe(false);
		expect(httpAuthorized(credentials({ authorization: "Bearer nope" }))).toBe(false);
		expect(httpAuthorized(credentials({ authorization: "Bearer sekret" }))).toBe(true);
		expect(httpAuthorized(credentials({ token: undefined }))).toBe(true);
	});

	test("the query token does not open a plain HTTP route", () => {
		expect(httpAuthorized(credentials())).toBe(false);
	});
});

describe("browser socket refusal (off-loopback peer)", () => {
	test("no credential or a wrong one is refused 4401", () => {
		for (const refused of [
			socketRefusal(credentials(), params()),
			socketRefusal(credentials(), params({ token: "nope" })),
			socketRefusal(credentials(), params({ token: "SEKRET" })),
			socketRefusal(credentials({ authorization: "Bearer nope" }), params()),
			socketRefusal(credentials({ authorization: "Bearer SEKRET" }), params()),
		]) {
			expect(refused?.code).toBe(4401);
			expect(refused?.reason).toStartWith("unauthorized:");
		}
	});

	test("the token query param is accepted, as is the Authorization header", () => {
		expect(socketRefusal(credentials(), params({ token: TOKEN }))).toBeNull();
		expect(socketRefusal(credentials({ authorization: "bearer sekret" }), params())).toBeNull();
	});

	test("loopback needs no credential, and a daemon with no token is open", () => {
		expect(socketRefusal(credentials({ loopback: true }), params())).toBeNull();
		expect(
			socketRefusal(credentials({ token: undefined }), params({ token: "anything" })),
		).toBeNull();
	});

	test("a loopback dial from a foreign browser page is refused 4403; off loopback the token decides", () => {
		const foreign = credentials({ loopback: true, browserAllowed: false });
		const refused = socketRefusal(foreign, params());
		expect(refused?.code).toBe(4403);
		expect(refused?.reason).toStartWith("forbidden:");
		// The token does not rescue a foreign loopback dial: loopback never carries one.
		expect(socketRefusal(foreign, params({ token: TOKEN }))?.code).toBe(4403);
		// A header-less CLI dial passes, and so does an off-loopback peer with the token.
		expect(socketRefusal(credentials({ loopback: true }), params())).toBeNull();
		expect(
			socketRefusal(credentials({ browserAllowed: false }), params({ token: TOKEN })),
		).toBeNull();
		// Auth is judged before the guard, proto after it.
		expect(socketRefusal(credentials({ browserAllowed: false }), params())?.code).toBe(4401);
		expect(socketRefusal(foreign, params({ proto: OMP_PROTO - 1 }))?.code).toBe(4403);
	});

	test("a missing or different proto is refused 4426, after auth", () => {
		const stale = socketRefusal(credentials({ loopback: true }), params({ proto: OMP_PROTO - 1 }));
		expect(stale?.code).toBe(4426);
		expect(socketRefusal(credentials({ loopback: true }), params({ proto: null }))?.code).toBe(
			4426,
		);
		// An unauthenticated peer learns nothing about the daemon's proto: auth wins.
		expect(socketRefusal(credentials(), params({ proto: OMP_PROTO - 1 }))?.code).toBe(4401);
	});
});
