import { describe, expect, test } from "bun:test";
import { type LoginProvider, groupProviders } from "../../components/models/provider-login";

const providers: LoginProvider[] = [
	{ id: "zeta", name: "Zeta AI", available: true, authenticated: false },
	{ id: "deepseek", name: "DeepSeek", available: true, authenticated: true },
	{ id: "moonshot", name: "Moonshot", available: true, authenticated: true },
	{ id: "anthropic", name: "Anthropic", available: false, authenticated: false },
	{ id: "alpha", name: "Alpha Labs", available: true, authenticated: false },
];

describe("groupProviders", () => {
	test("lists signed-in providers first, each group sorted by name", () => {
		const groups = groupProviders(providers, "");
		expect(groups.signedIn.map((p) => p.id)).toEqual(["deepseek", "moonshot"]);
		expect(groups.available.map((p) => p.id)).toEqual(["alpha", "anthropic", "zeta"]);
	});

	test("filters by name or id, case-insensitively, keeping the group split", () => {
		expect(groupProviders(providers, "  MOON ").signedIn.map((p) => p.id)).toEqual(["moonshot"]);
		expect(groupProviders(providers, "moon").available).toEqual([]);
		expect(groupProviders(providers, "alpha").available.map((p) => p.id)).toEqual(["alpha"]);
		expect(groupProviders(providers, "no-such-provider")).toEqual({ signedIn: [], available: [] });
	});

	test("does not mutate the input order", () => {
		const before = providers.map((p) => p.id);
		groupProviders(providers, "");
		expect(providers.map((p) => p.id)).toEqual(before);
	});
});
