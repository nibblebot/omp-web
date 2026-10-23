import { describe, expect, test } from "bun:test";
import type { AvailableSlashCommand } from "#lib/wire/protocol";
import { fuzzyRank } from "../../prompt/autocomplete";
import {
	buildCommandRegistry,
	type CommandEntry,
	type CommandRegistryInput,
	commandLiveState,
	findCommand,
	isAvailable,
	isSdkHandled,
	rankCommands,
	refusalNotice,
	suggestCommand,
	unknownCommandNotice,
} from "../../prompt/command-registry";

const LOCAL_NAMES = [
	"new",
	"clear",
	"compact",
	"help",
	"hotkeys",
	"exit",
	"quit",
	"live",
	"move",
	"wt",
	"worktree",
	"plan",
	"queue",
	"usage",
	"context",
	"tools",
	"settings",
	"rename",
	"fresh",
	"delete",
	"model",
	"modelpreset",
];

function registry(overrides: Partial<CommandRegistryInput> = {}): CommandEntry[] {
	return buildCommandRegistry({
		localNames: LOCAL_NAMES,
		remote: [],
		featureOf: () => undefined,
		...overrides,
	});
}

function entry(entries: readonly CommandEntry[], name: string): CommandEntry {
	const found = entries.find((e) => e.name === name);
	if (!found) throw new Error(`no registry entry named ${name}`);
	return found;
}

describe("command registry classification", () => {
	test("SDK builtins with a terminal-only handler are tui-only, with a notice naming the web alternative", () => {
		const copy = entry(registry(), "copy");
		expect(copy.kind).toBe("tui-only");
		expect(copy.notice).toBe(
			"/copy is terminal-only and is not available in the browser. Select text in the transcript and copy it.",
		);
	});

	test("/stats and /trace are tui-only and point at /usage", () => {
		const entries = registry();
		for (const name of ["stats", "trace"]) {
			const e = entry(entries, name);
			expect(e.kind).toBe("tui-only");
			expect(e.notice).toContain("Use /usage for session statistics.");
		}
	});

	test("/collab, /join and /leave are tui-only, so the browser never forwards them", () => {
		const entries = registry();
		for (const name of ["collab", "join", "leave"]) {
			expect(entry(entries, name).kind).toBe("tui-only");
			expect(isSdkHandled(name)).toBe(false);
		}
	});

	test("local handlers stay local", () => {
		expect(entry(registry(), "compact").kind).toBe("local");
	});

	test("SDK builtins with a headless handler are forwarded", () => {
		const security = entry(registry(), "security");
		expect(security.kind).toBe("forwarded");
		expect(security.hint).toBe(
			"<plan|scan|status|cancel|scans|show|import|export|validate|compare|disposition>",
		);
	});

	test("remote commands join as forwarded, and never shadow a builtin", () => {
		const remote: AvailableSlashCommand[] = [
			{
				name: "deploy",
				description: "Deploy the app",
				input: { hint: "<env>" },
				source: "skill",
			},
			{ name: "settings", description: "custom override", source: "custom" },
		];
		const entries = registry({ remote });
		const deploy = entry(entries, "deploy");
		expect(deploy.kind).toBe("forwarded");
		expect(deploy.hint).toBe("<env>");
		expect(entry(entries, "settings").kind).toBe("local");
	});
});

describe("isSdkHandled", () => {
	test("is true only for headless SDK builtins the browser can run", () => {
		expect(isSdkHandled("security")).toBe(true);
		expect(isSdkHandled("settings")).toBe(false);
		expect(isSdkHandled("stats")).toBe(false);
		expect(isSdkHandled("trace")).toBe(false);
		expect(isSdkHandled("no-such-command")).toBe(false);
	});

	test("resolves aliases to their builtin", () => {
		expect(isSdkHandled("providers")).toBe(isSdkHandled("setup"));
	});
});

describe("findCommand", () => {
	test("resolves a name case-insensitively and an alias to its entry", () => {
		const entries = registry();
		expect(findCommand(entries, "PROVIDERS")?.name).toBe("setup");
		expect(findCommand(entries, "compact")?.name).toBe("compact");
	});

	test("returns undefined for an unknown name", () => {
		expect(findCommand(registry(), "no-such-command")).toBeUndefined();
	});
});

describe("suggestCommand and unknownCommandNotice", () => {
	test("a prefix suggests the command it completes", () => {
		expect(suggestCommand(registry(), "comp", new Map())?.name).toBe("compact");
	});

	test("a one-letter typo suggests the nearest command", () => {
		expect(suggestCommand(registry(), "helpp", new Map())?.name).toBe("help");
	});

	test("a distant name suggests nothing", () => {
		expect(suggestCommand(registry(), "zzzzzzzz", new Map())).toBeUndefined();
	});

	test("the notice names the suggestion, or points at /help", () => {
		const help = entry(registry(), "help");
		expect(unknownCommandNotice("helpp", help)).toBe("Unknown command /helpp, did you mean /help?");
		expect(unknownCommandNotice("foo", undefined)).toBe(
			"Unknown command /foo. Type /help to list commands.",
		);
	});
});

describe("refusals and availability", () => {
	test("a refused command is not available and gets its reason as a notice", () => {
		const live = entry(registry(), "live");
		expect(isAvailable(live)).toBe(false);
		expect(refusalNotice(live)).toBe("/live: Realtime voice runs in the omp terminal UI.");
	});

	test("exit explains that the session persists", () => {
		expect(refusalNotice(entry(registry(), "exit"))).toBe(
			"/exit: Close this browser tab; the session persists.",
		);
	});

	test("a command owned by a disabled feature is unavailable and names the feature", () => {
		const entries = registry({
			featureOf: (name) =>
				name === "plan"
					? { id: "plan", label: "Plan mode", status: "stable", enabled: false }
					: undefined,
		});
		const plan = entry(entries, "plan");
		expect(isAvailable(plan)).toBe(false);
		expect(refusalNotice(plan)).toBe(
			"/plan is part of Plan mode, which is disabled. Enable it in Settings > Features.",
		);
	});

	test("a command owned by an in-development feature has no enable hint", () => {
		const entries = registry({
			featureOf: (name) =>
				name === "plan"
					? { id: "plan", label: "Plan mode", status: "in-development", enabled: false }
					: undefined,
		});
		expect(refusalNotice(entry(entries, "plan"))).toBe(
			"/plan is part of Plan mode, which is in development.",
		);
	});

	test("a runnable command has no refusal notice", () => {
		expect(refusalNotice(entry(registry(), "compact"))).toBeUndefined();
	});
});

describe("commandLiveState", () => {
	test("shows the live value beside the commands that have one", () => {
		expect(commandLiveState("model", { model: { id: "opus" } })).toBe("opus");
		expect(commandLiveState("plan", { planModeEnabled: true })).toBe("on");
		expect(commandLiveState("plan", { planModeEnabled: false })).toBe("off");
		expect(commandLiveState("queue", { queuedMessageCount: 2 })).toBe("2 queued");
		expect(commandLiveState("compact", { contextUsage: { percent: 42.4 } })).toBe("42% used");
		expect(commandLiveState("rename", { sessionName: "Refactor" })).toBe("Refactor");
		expect(
			commandLiveState("modelpreset", { modelPresets: { names: ["fast"], active: "fast" } }),
		).toBe("fast");
	});

	test("shows nothing when there is no value", () => {
		expect(commandLiveState("queue", { queuedMessageCount: 0 })).toBeUndefined();
		expect(commandLiveState("rename", { sessionName: "" })).toBeUndefined();
		expect(commandLiveState("help", {})).toBeUndefined();
		expect(commandLiveState("modelpreset", { modelPresets: { names: ["fast"] } })).toBeUndefined();
	});
});

describe("model commands", () => {
	test("/model and /modelpreset are local, grouped under Model, and carry their hints", () => {
		const byName = new Map(registry().map((c) => [c.name, c]));
		expect(byName.get("model")).toMatchObject({ kind: "local", group: "Model", hint: "[model]" });
		expect(byName.get("modelpreset")).toMatchObject({ kind: "local", group: "Model" });
		expect(byName.get("modelpreset")?.hint).toContain("switch");
	});
});

describe("rankCommands", () => {
	test("an empty query lists every available entry and nothing refused or terminal-only", () => {
		const names = rankCommands(registry(), "", new Map(), fuzzyRank).map((r) => r.entry.name);
		expect(names).toContain("compact");
		expect(names).toContain("settings");
		expect(names).not.toContain("live");
		expect(names).not.toContain("stats");
	});

	test("the shortest exact-prefix match ranks first", () => {
		const names = rankCommands(registry(), "com", new Map(), fuzzyRank).map((r) => r.entry.name);
		expect(names[0]).toBe("compact");
	});

	test("local usage outranks the static pin within a match tier", () => {
		const usage = new Map([["compaction", 5]]);
		const names = rankCommands(registry(), "com", usage, fuzzyRank).map((r) => r.entry.name);
		expect(names.indexOf("compaction")).toBeLessThan(names.indexOf("compact"));
	});
});
