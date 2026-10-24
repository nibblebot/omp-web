/**
 * jx0b (CMD-08): classification table. Every forwarded command in the registry
 * gets exactly one busy policy from the shared slashBusyPolicy; the registry
 * must carry the source that policy reads. Evidence for each row is in the kata
 * comment (pinned SDK handlers).
 */
import { describe, expect, test } from "bun:test";
import { slashBusyPolicy } from "#lib/wire/slash-busy";
import type { AvailableSlashCommand } from "#lib/wire/protocol";
import { featureForCommand } from "../../features/manifest";
import { buildCommandRegistry, findCommand } from "../../prompt/command-registry";
import { LOCAL_COMMANDS } from "../../prompt/commands";

/** Forwarded SDK builtins that run at once mid-turn: read-only output. */
const RUN_NOW = ["changelog", "dirs", "jobs"];

/** Forwarded SDK builtins that queue mid-turn, with the reason in the kata comment. */
const QUEUED = [
	"security",
	"switch",
	"fast",
	"slow",
	"skillful",
	"extended-context",
	"computer",
	"ratchet",
	"prewalk",
	"effort",
	"advisor",
	"share",
	"browser",
	"ssh",
	"shake",
	"pin",
	"memory",
	"add-dir",
	"remove-dir",
	"marketplace",
	"plugins",
	"reload-plugins",
	"force",
	"forget-approvals",
];

function registry(remote: AvailableSlashCommand[] = []) {
	return buildCommandRegistry({
		localNames: Object.keys(LOCAL_COMMANDS),
		remote,
		// Feature-owned commands are local in the app (/todo belongs to the Todos feature), never forwarded.
		featureOf: (name) => {
			const f = featureForCommand(name);
			return f ? { id: f.id, label: f.label, status: f.status, enabled: false } : undefined;
		},
	});
}

describe("forwarded builtin busy classification", () => {
	const forwarded = registry().filter((e) => e.kind === "forwarded");

	test("every forwarded builtin is classified: run-now, queued, or session", () => {
		const names = forwarded.map((e) => e.name).sort();
		expect(names).toEqual([...RUN_NOW, ...QUEUED, "session"].sort());
	});

	test("run-now builtins run at once while busy", () => {
		for (const name of RUN_NOW) {
			const entry = forwarded.find((e) => e.name === name);
			expect(entry).toBeDefined();
			expect(slashBusyPolicy({ source: entry!.source, name: entry!.name })).toBe("now");
		}
	});

	test("every other forwarded builtin queues while busy", () => {
		for (const name of QUEUED) {
			const entry = forwarded.find((e) => e.name === name);
			expect(entry).toBeDefined();
			expect(slashBusyPolicy({ source: entry!.source, name: entry!.name })).toBe("queue");
		}
	});

	test("/session policy follows its subcommand", () => {
		const session = forwarded.find((e) => e.name === "session")!;
		expect(slashBusyPolicy({ source: session.source, name: "session", args: "delete" })).toBe(
			"refuse",
		);
		expect(slashBusyPolicy({ source: session.source, name: "session", args: "info" })).toBe("now");
	});
});

describe("non-builtin command busy classification", () => {
	const remote: AvailableSlashCommand[] = [
		{ name: "skill:lint", source: "skill" },
		{ name: "fix-bug", source: "file" },
		{ name: "deploy", source: "custom" },
		{ name: "prompt-x", source: "mcp_prompt" },
		{ name: "ext-status", source: "extension" },
	];
	const reg = registry(remote);

	test("skill, file, custom, MCP prompt and extension commands queue", () => {
		for (const name of ["skill:lint", "fix-bug", "deploy", "prompt-x", "ext-status"]) {
			const entry = findCommand(reg, name);
			expect(entry).toBeDefined();
			expect(slashBusyPolicy({ source: entry!.source, name: entry!.name })).toBe("queue");
		}
	});
});
