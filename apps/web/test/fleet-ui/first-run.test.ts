import { describe, expect, test } from "bun:test";
import type { OmpSetupStatus } from "#lib/wire/protocol";
import { ompSetupSummary } from "../../fleet-ui/first-run";

describe("ompSetupSummary", () => {
	test("reports omp, signed-in providers, and the default model", () => {
		const ready: OmpSetupStatus = {
			ompInstalled: true,
			providers: ["anthropic"],
			defaultModel: "anthropic/claude-sonnet-4",
			error: null,
		};
		expect(ompSetupSummary(ready)).toBe(
			"omp found · signed in: anthropic · default model anthropic/claude-sonnet-4",
		);
	});

	test("flags a missing omp, no providers, and no default model", () => {
		const bare: OmpSetupStatus = {
			ompInstalled: false,
			providers: [],
			defaultModel: null,
			error: null,
		};
		expect(ompSetupSummary(bare)).toBe(
			"omp not found on PATH, install omp and re-check · no provider signed in yet · no default model set",
		);
	});
});
