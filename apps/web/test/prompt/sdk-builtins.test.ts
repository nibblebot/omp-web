import { describe, expect, test } from "bun:test";
import { BUILTIN_SLASH_COMMANDS_INTERNAL } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { SDK_BUILTINS } from "../../prompt/sdk-builtins";

// Re-reads the SDK's builtin registry so a pin bump that adds, renames, or
// re-handles a builtin fails here instead of silently misrouting in the browser.
const sdk = new Map(BUILTIN_SLASH_COMMANDS_INTERNAL.map((spec) => [spec.name, spec] as const));
const mirror = new Map(SDK_BUILTINS.map((b) => [b.name, b] as const));

describe("SDK builtin mirror", () => {
	test("covers exactly the SDK's builtin names", () => {
		expect([...mirror.keys()].sort()).toEqual([...sdk.keys()].sort());
	});

	test("aliases match the SDK", () => {
		for (const [name, spec] of sdk) {
			expect({ name, aliases: [...(mirror.get(name)?.aliases ?? [])] }).toEqual({
				name,
				aliases: spec.aliases ?? [],
			});
		}
	});

	test("sdkHandled matches whether the SDK ships a headless handler", () => {
		for (const [name, spec] of sdk) {
			expect({ name, sdkHandled: mirror.get(name)?.sdkHandled }).toEqual({
				name,
				sdkHandled: spec.handle !== undefined,
			});
		}
	});
});
