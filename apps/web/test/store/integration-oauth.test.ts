import { describe, expect, test } from "bun:test";
import { validateOAuthLaunchUrl } from "../../store/integration-oauth";

describe("integration OAuth popup boundary", () => {
	test("permits provider authorization state and PKCE without exposing credentials", () => {
		const url =
			"https://provider.example/authorize?client_id=public&state=opaque&code_challenge=pkce&redirect_uri=http%3A%2F%2F127.0.0.1%3A8765%2Fcallback";
		expect(validateOAuthLaunchUrl(url)).toBe(url);
	});
	test("rejects executable, plaintext, and credential-bearing launch URLs", () => {
		for (const value of [
			null,
			{},
			"javascript:alert(1)",
			"http://provider.example/auth",
			"https://user:password@provider.example/auth",
			"https://provider.example/auth?access_token=secret",
			"https://provider.example/auth?REFRESH_TOKEN=secret",
			"https://provider.example/auth?id_token=secret",
			"https://provider.example/auth?client_secret=secret",
		]) {
			expect(() => validateOAuthLaunchUrl(value)).toThrow();
		}
	});
});
