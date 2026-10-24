import type { Effort } from "@oh-my-pi/pi-catalog/effort";
import type { SessionStats } from "@oh-my-pi/pi-coding-agent/session/agent-session-types";
import type { SessionListEntry } from "#lib/wire/protocol";
import type { ChatItem, state, ToolItem } from "../../web/state";
import { rosterAppDaemons } from "./roster";
import { claude, screenItems, screenSessionView, SCREEN_DAEMON_ID, turnUsage } from "./screen";
import { FIXTURE_NOW } from "./session";

/** Per-session store fields restored on attach (no fleet-scoped fields like daemonRoster, connected, availableModels). */
export type AppSessionView = Pick<
	typeof state,
	| "readyAt"
	| "sessionId"
	| "sessionName"
	| "sessionFile"
	| "model"
	| "thinkingLevel"
	| "contextUsage"
	| "stats"
	| "messageCount"
>;

/** One roster session: the store fields it restores on attach and the transcript it shows. */
export interface AppSession {
	view: AppSessionView;
	items: ChatItem[];
}

type RosterDaemon = (typeof rosterAppDaemons)[number];

/** The roster row for `daemonId`, so names, branches and times come from one place. */
function rosterDaemon(daemonId: string): RosterDaemon {
	const daemon = rosterAppDaemons.find((entry) => entry.daemonId === daemonId);
	if (!daemon) throw new Error(`app-sessions: ${daemonId} is not in rosterAppDaemons`);
	return daemon;
}

/** Joins lines the way a tool result carries them. */
const lines = (...rows: string[]): string => rows.join("\n");

/** Finished tool call; ids are unique within one transcript. */
const tool = (id: number, name: string, args: unknown, output: string): ToolItem => ({
	kind: "tool",
	id,
	toolCallId: `call_${name}_${id}`,
	name,
	args,
	status: "done",
	output,
});

/** Context window used for the usage bar; matches the screen transcript. */
const CONTEXT_WINDOW = 200_000;

/** Derives stats, context and message count from the transcript, so the counts always match it. */
function sessionView(daemonId: string, sessionId: string, items: ChatItem[]): AppSessionView {
	const daemon = rosterDaemon(daemonId);
	const sessionFile = daemon.lastSessionFile;
	if (!sessionFile) throw new Error(`app-sessions: ${daemonId} has no lastSessionFile`);

	const tokens = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
	let userMessages = 0;
	let assistantMessages = 0;
	let toolCalls = 0;
	let contextTokens = 0;
	for (const item of items) {
		if (item.kind === "user") userMessages += 1;
		if (item.kind === "tool") toolCalls += 1;
		if (item.kind !== "assistant") continue;
		assistantMessages += 1;
		const usage = item.usage;
		if (!usage) continue;
		tokens.input += usage.input;
		tokens.output += usage.output;
		tokens.cacheRead += usage.cacheRead;
		tokens.cacheWrite += usage.cacheWrite;
		// Reasoning tokens are the output of turns that thought before they answered.
		if (item.blocks.some((block) => block.kind === "thinking")) tokens.reasoning += usage.output;
		// Context is what the last turn sent: fresh input plus the cache it read.
		contextTokens = usage.input + usage.cacheRead;
	}

	const { cost } = claude;
	const dollars =
		(tokens.input * cost.input +
			tokens.output * cost.output +
			tokens.cacheRead * cost.cacheRead +
			tokens.cacheWrite * cost.cacheWrite) /
		1_000_000;
	const toolResults = toolCalls;
	const totalMessages = userMessages + assistantMessages + toolResults;
	const stats: SessionStats = {
		sessionFile,
		sessionId,
		userMessages,
		assistantMessages,
		toolCalls,
		toolResults,
		totalMessages,
		tokens: {
			...tokens,
			total: tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite,
		},
		premiumRequests: 0,
		cost: Math.round(dollars * 100) / 100,
	};
	return {
		readyAt: daemon.readyAt ?? FIXTURE_NOW,
		sessionId,
		sessionName: daemon.sessionTitle,
		sessionFile,
		model: claude,
		thinkingLevel: "medium" as Effort,
		contextUsage: {
			tokens: contextTokens,
			contextWindow: CONTEXT_WINDOW,
			percent: Math.round((contextTokens / CONTEXT_WINDOW) * 1000) / 10,
		},
		stats,
		messageCount: totalMessages,
	};
}

/** A roster session: its store view derived from the transcript, and the transcript itself. */
const session = (daemonId: string, sessionId: string, items: ChatItem[]): AppSession => ({
	view: sessionView(daemonId, sessionId, items),
	items,
});

// ---------------------------------------------------------------------------
// omp-web (Bun and TypeScript).
// ---------------------------------------------------------------------------

/** omp-web main: both SDK manifests move to 18.9.0, and a new script guards the pins. */
const ompWebMain: ChatItem[] = [
	{
		kind: "user",
		id: 1,
		text: "The SDK pins are still on 18.7 in two manifests. Move @oh-my-pi/pi-ai and @oh-my-pi/pi-coding-agent to 18.9.0 in both, and add a check so they cannot drift apart again.",
	},
	{
		kind: "assistant",
		id: 2,
		blocks: [
			{
				kind: "thinking",
				text: "The root and the web app each pin the SDK. If only one moves, the design system resolves a different session shape than the app, so both manifests change together.",
			},
			{
				kind: "text",
				text: "I'll find every pin, bump both manifests, and add a script that fails when they disagree.",
			},
		],
		usage: turnUsage(8_212, 236, 7_904),
		ttft: 812,
		duration: 3_940,
	},
	tool(
		3,
		"grep",
		{ pattern: "@oh-my-pi/pi-(ai|coding-agent)", path: "." },
		lines(
			'package.json:14:    "@oh-my-pi/pi-ai": "18.7.2",',
			'package.json:15:    "@oh-my-pi/pi-coding-agent": "18.7.2",',
			'apps/web/package.json:9:    "@oh-my-pi/pi-ai": "18.7.2",',
			'apps/web/package.json:10:    "@oh-my-pi/pi-coding-agent": "18.7.2",',
		),
	),
	tool(
		4,
		"edit",
		{
			path: "package.json",
			edits: [
				{
					oldText: lines(
						'    "@oh-my-pi/pi-ai": "18.7.2",',
						'    "@oh-my-pi/pi-coding-agent": "18.7.2",',
					),
					newText: lines(
						'    "@oh-my-pi/pi-ai": "18.9.0",',
						'    "@oh-my-pi/pi-coding-agent": "18.9.0",',
					),
				},
			],
		},
		"Applied 1 edit to package.json",
	),
	tool(
		5,
		"edit",
		{
			path: "apps/web/package.json",
			edits: [
				{
					oldText: lines(
						'    "@oh-my-pi/pi-ai": "18.7.2",',
						'    "@oh-my-pi/pi-coding-agent": "18.7.2",',
					),
					newText: lines(
						'    "@oh-my-pi/pi-ai": "18.9.0",',
						'    "@oh-my-pi/pi-coding-agent": "18.9.0",',
					),
				},
			],
		},
		"Applied 1 edit to apps/web/package.json",
	),
	tool(
		6,
		"write",
		{
			path: "scripts/check-sdk-pins.ts",
			content: lines(
				'import { readFileSync } from "node:fs";',
				"",
				'const manifests = ["package.json", "apps/web/package.json"];',
				'const sdk = ["@oh-my-pi/pi-ai", "@oh-my-pi/pi-coding-agent"];',
				"",
				"const seen = new Map<string, Set<string>>();",
				"for (const path of manifests) {",
				'\tconst deps: Record<string, string> = JSON.parse(readFileSync(path, "utf8")).dependencies ?? {};',
				"\tfor (const name of sdk) {",
				"\t\tconst pins = seen.get(name) ?? new Set<string>();",
				'\t\tpins.add(deps[name] ?? "missing");',
				"\t\tseen.set(name, pins);",
				"\t}",
				"}",
				"",
				"const drift = [...seen].filter(([, pins]) => pins.size > 1);",
				'for (const [name, pins] of drift) console.error(`${name} is pinned to ${[...pins].join(", ")}`);',
				"process.exit(drift.length > 0 ? 1 : 0);",
			),
		},
		"Wrote 18 lines to scripts/check-sdk-pins.ts",
	),
	{
		kind: "assistant",
		id: 7,
		blocks: [
			{
				kind: "text",
				text: [
					"## Summary",
					"",
					"Both manifests now pin `@oh-my-pi/pi-ai` and `@oh-my-pi/pi-coding-agent` to `18.9.0`, and `scripts/check-sdk-pins.ts` fails when they disagree.",
					"",
					"| File | Change |",
					"| --- | --- |",
					"| `package.json` | SDK pins to 18.9.0 |",
					"| `apps/web/package.json` | SDK pins to 18.9.0 |",
					"| `scripts/check-sdk-pins.ts` | new drift check |",
					"",
					"`bun.lock` is untouched. Run `bun install` before the types check so the lockfile picks up the new pins.",
				].join("\n"),
			},
		],
		usage: turnUsage(10_480, 611, 9_920),
		ttft: 690,
		duration: 8_120,
	},
];

/** omp-web review-anchors (asleep, clean tree): the anchor kind is committed; the render path is what is left. */
const ompWebReview: ChatItem[] = [
	{
		kind: "user",
		id: 1,
		text: "Review annotations pin to line numbers, so an edit above them moves the pin onto the wrong line. Where does the anchor migration stand on this branch?",
	},
	{
		kind: "assistant",
		id: 2,
		blocks: [
			{
				kind: "thinking",
				text: "Annotations keep a line number, so every edit above them shifts the pin. Anchor annotations keep the text they were made on and resolve by content. I need to see which half has landed.",
			},
			{
				kind: "text",
				text: "I'll check the annotation type and the git history before deciding what is left.",
			},
		],
		usage: turnUsage(7_640, 198, 7_120),
		ttft: 744,
		duration: 3_410,
	},
	tool(
		3,
		"grep",
		{ pattern: "anchor|a\\.line", path: "apps/web" },
		lines(
			'apps/web/store/review.ts:46:\tkind: "line" | "anchor";',
			'apps/web/store/review.ts:118:\tif (a.kind === "anchor") return resolveAnchor(a);',
			"apps/web/store/review.ts:124:\treturn a.line;",
			"apps/web/components/review/Annotation.tsx:37:\t\tpin={a.line}",
		),
	),
	tool(
		4,
		"read",
		{ path: "apps/web/store/review.ts", offset: 40, limit: 8 },
		lines(
			"40→export interface Annotation {",
			"41→\tid: string;",
			"42→\tfile: string;",
			"43→\ttext: string;",
			"44→\tline: number;",
			"45→\tanchorText?: string;",
			'46→\tkind: "line" | "anchor";',
			"47→}",
		),
	),
	tool(
		5,
		"bash",
		{ command: "git status --short && git log --oneline -3" },
		lines(
			"3f9a2c1 review: resolve anchor annotations by their text",
			"b7d04e8 review: add anchor kind to Annotation",
			"1c5e0aa review: keep stale line pins for old sessions",
		),
	),
	{
		kind: "assistant",
		id: 6,
		blocks: [
			{
				kind: "text",
				text: [
					"## Summary",
					"",
					"The anchor kind is committed on `fix/review-anchors`, and the tree is clean.",
					"",
					"- `Annotation.kind` is `line` or `anchor`, and anchors keep the text they were made on.",
					"- `resolveAnchor` finds that text again, so an edit above an anchor no longer moves its pin.",
					"- `Annotation.tsx` still reads `a.line` for every annotation, so the render path has not moved yet.",
					"",
					"Left to do: point `Annotation.tsx` at the resolved position, then run `scripts/test.ts apps/web/test/review.test.ts`.",
				].join("\n"),
			},
		],
		usage: turnUsage(9_016, 402, 8_560),
		ttft: 705,
		duration: 6_830,
	},
];

// ---------------------------------------------------------------------------
// localaction (Go CLI that runs GitHub Actions workflows locally).
// ---------------------------------------------------------------------------

/** localaction main: action checkouts cache between runs and the legacy clone path goes. */
const localactionMain: ChatItem[] = [
	{
		kind: "user",
		id: 1,
		text: "Every run clones each action from scratch, so actions/checkout dominates the job time. Cache checkouts between runs, keyed by owner, repo and ref, and remove the old per-run clone path.",
	},
	{
		kind: "assistant",
		id: 2,
		blocks: [
			{
				kind: "thinking",
				text: "Checkouts are rebuilt inside each run's work dir. A cache under the state dir turns a repeat run into a copy instead of a network clone, and the legacy path can go once the cache covers it.",
			},
			{
				kind: "text",
				text: "I'll find the clone path, read it, and switch it to the cache.",
			},
		],
		usage: turnUsage(9_402, 284, 8_640),
		ttft: 880,
		duration: 4_270,
	},
	tool(
		3,
		"grep",
		{ pattern: "func .*[Cc]lone", path: "internal/actions" },
		lines(
			"internal/actions/checkout.go:21:func cloneAction(ctx context.Context, spec ActionSpec, dst string) error {",
			"internal/actions/legacy_checkout.go:9:func legacyClone(spec ActionSpec, dst string) error {",
		),
	),
	tool(
		4,
		"read",
		{ path: "internal/actions/checkout.go", offset: 21, limit: 6 },
		lines(
			"21→func cloneAction(ctx context.Context, spec ActionSpec, dst string) error {",
			"22→\tif err := os.MkdirAll(dst, 0o755); err != nil {",
			"23→\t\treturn err",
			"24→\t}",
			'25→\treturn exec.CommandContext(ctx, "git", "clone", spec.URL(), dst).Run()',
			"26→}",
		),
	),
	tool(
		5,
		"edit",
		{
			path: "internal/actions/checkout.go",
			edits: [
				{
					oldText: lines(
						"func cloneAction(ctx context.Context, spec ActionSpec, dst string) error {",
						"\tif err := os.MkdirAll(dst, 0o755); err != nil {",
						"\t\treturn err",
						"\t}",
						'\treturn exec.CommandContext(ctx, "git", "clone", spec.URL(), dst).Run()',
						"}",
					),
					newText: lines(
						"func cloneAction(ctx context.Context, spec ActionSpec, dst string) error {",
						'\tcache := filepath.Join(stateDir(), "actions", spec.Owner, spec.Repo, spec.Ref)',
						"\tif _, err := os.Stat(cache); os.IsNotExist(err) {",
						'\t\tif err := exec.CommandContext(ctx, "git", "clone", "--branch", spec.Ref, spec.URL(), cache).Run(); err != nil {',
						"\t\t\treturn err",
						"\t\t}",
						"\t}",
						"\treturn copyTree(cache, dst)",
						"}",
					),
				},
			],
		},
		"Applied 1 edit to internal/actions/checkout.go",
	),
	tool(6, "bash", { command: "rm internal/actions/legacy_checkout.go && go build ./..." }, ""),
	{
		kind: "assistant",
		id: 7,
		blocks: [
			{
				kind: "text",
				text: [
					"## Summary",
					"",
					"Action checkouts are cached under the state dir, keyed by owner, repo and ref. A repeat run copies from the cache instead of cloning over the network.",
					"",
					"| File | Change |",
					"| --- | --- |",
					"| `internal/actions/checkout.go` | clones into the cache, then copies into the work dir |",
					"| `internal/actions/legacy_checkout.go` | removed |",
					"",
					"The build is clean. The cache has no size cap yet, so the state dir grows until eviction lands.",
				].join("\n"),
			},
		],
		usage: turnUsage(12_118, 740, 11_360),
		ttft: 760,
		duration: 7_540,
	},
];

/** localaction job-matrix: each matrix combination becomes its own job, carried in Job.Matrix. */
const localactionMatrix: ChatItem[] = [
	{
		kind: "user",
		id: 1,
		text: "A matrix strategy still runs as one job, so the logs and the cache keys are per workflow. Expand each combination into its own job, the way GitHub does it.",
	},
	{
		kind: "assistant",
		id: 2,
		blocks: [
			{
				kind: "thinking",
				text: "Combinations are built in strategy.go but never reach the scheduler. Expanding them before scheduling gives each combination its own job and its own log group.",
			},
			{
				kind: "text",
				text: "I'll put the expansion in a new matrix.go, then point the strategy, the job list and the job type at it.",
			},
		],
		usage: turnUsage(10_224, 318, 9_760),
		ttft: 790,
		duration: 5_120,
	},
	tool(
		3,
		"edit",
		{
			path: "internal/workflow/strategy.go",
			edits: [
				{
					oldText: lines("func (s Strategy) Combinations() [][]string {", "\treturn nil", "}"),
					newText: lines(
						"func (s Strategy) Combinations() []Combination {",
						"\treturn expandMatrix(s.Matrix)",
						"}",
					),
				},
			],
		},
		"Applied 1 edit to internal/workflow/strategy.go",
	),
	tool(
		4,
		"write",
		{
			path: "internal/workflow/matrix.go",
			content: lines(
				"package workflow",
				"",
				'import "sort"',
				"",
				"// Combination is one matrix entry: the value of each axis, keyed by axis name.",
				"type Combination map[string]string",
				"",
				"// expandMatrix returns the cross product of the matrix axes in a stable order.",
				"func expandMatrix(matrix map[string][]string) []Combination {",
				"\taxes := make([]string, 0, len(matrix))",
				"\tfor axis := range matrix {",
				"\t\taxes = append(axes, axis)",
				"\t}",
				"\tsort.Strings(axes)",
				"\tcombos := []Combination{{}}",
				"\tfor _, axis := range axes {",
				"\t\tvar next []Combination",
				"\t\tfor _, combo := range combos {",
				"\t\t\tfor _, value := range matrix[axis] {",
				"\t\t\t\tc := Combination{axis: value}",
				"\t\t\t\tfor k, v := range combo {",
				"\t\t\t\t\tc[k] = v",
				"\t\t\t\t}",
				"\t\t\t\tnext = append(next, c)",
				"\t\t\t}",
				"\t\t}",
				"\t\tcombos = next",
				"\t}",
				"\treturn combos",
				"}",
			),
		},
		"Wrote 30 lines to internal/workflow/matrix.go",
	),
	tool(
		5,
		"edit",
		{
			path: "internal/workflow/jobs.go",
			edits: [
				{
					oldText: lines("\tfor _, job := range wf.Jobs {", "\t\tsched.Add(job)", "\t}"),
					newText: lines(
						"\tfor _, job := range wf.Jobs {",
						"\t\tfor _, combo := range job.Strategy.Combinations() {",
						"\t\t\tsched.Add(job.Expand(combo))",
						"\t\t}",
						"\t}",
					),
				},
			],
		},
		"Applied 1 edit to internal/workflow/jobs.go",
	),
	tool(
		6,
		"edit",
		{
			path: "internal/workflow/workflow.go",
			edits: [
				{
					oldText: lines(
						"type Job struct {",
						"\tID       string",
						"\tRunsOn   string",
						"\tSteps    []Step",
						"}",
					),
					newText: lines(
						"type Job struct {",
						"\tID       string",
						"\tRunsOn   string",
						"\tSteps    []Step",
						"\tStrategy Strategy",
						"\tMatrix   Combination",
						"}",
						"",
						"// Expand returns a copy of the job that runs one matrix combination.",
						"func (j Job) Expand(combo Combination) Job {",
						"\tj.Matrix = combo",
						"\treturn j",
						"}",
					),
				},
			],
		},
		"Applied 1 edit to internal/workflow/workflow.go",
	),
	{
		kind: "assistant",
		id: 7,
		blocks: [
			{
				kind: "text",
				text: [
					"## Summary",
					"",
					"Each matrix combination now becomes its own job. A job carries its combination in `Job.Matrix`, so logs and cache keys are per combination.",
					"",
					"| File | Change |",
					"| --- | --- |",
					"| `internal/workflow/matrix.go` | new, cross product of the axes in stable order |",
					"| `internal/workflow/strategy.go` | `Combinations` returns the expansion |",
					"| `internal/workflow/jobs.go` | schedules one job per combination |",
					"| `internal/workflow/workflow.go` | `Job.Strategy`, `Job.Matrix` and `Job.Expand` |",
					"",
					"`fail-fast` and `max-parallel` are not handled yet, so they still apply to the whole strategy.",
				].join("\n"),
			},
		],
		usage: turnUsage(13_506, 868, 12_880),
		ttft: 730,
		duration: 8_960,
	},
];

/** localaction artifact-paths (asleep, clean tree): artifact names use forward slashes, already committed. */
const localactionArtifacts: ChatItem[] = [
	{
		kind: "user",
		id: 1,
		text: "Artifact uploads fail on the Windows runner because the path separator leaks into the artifact name. Normalize upload paths to forward slashes and cover the Windows case with a test.",
	},
	{
		kind: "assistant",
		id: 2,
		blocks: [
			{
				kind: "thinking",
				text: "filepath.Join uses the host separator, so a Windows runner produces backslashes. The artifact server stores names with forward slashes, so path.Join is the right call for names and filepath stays for local reads.",
			},
			{
				kind: "text",
				text: "I'll find where upload names are built and check the existing tests for a Windows case.",
			},
		],
		usage: turnUsage(6_980, 175, 6_400),
		ttft: 826,
		duration: 3_650,
	},
	tool(
		3,
		"grep",
		{ pattern: "Join", path: "internal/artifacts" },
		lines(
			"internal/artifacts/upload.go:30:\tname := path.Join(job, rel)",
			"internal/artifacts/upload.go:58:\treturn filepath.Join(root, name)",
			'internal/artifacts/upload_test.go:12:\t\tpath.Join("out", "dist"),',
		),
	),
	tool(
		4,
		"read",
		{ path: "internal/artifacts/upload.go", offset: 28, limit: 4 },
		lines(
			"28→// artifactName builds the name the upload server stores the file under.",
			"29→func artifactName(job, rel string) string {",
			"30→\tname := path.Join(job, rel)",
			"31→\treturn name",
		),
	),
	tool(
		5,
		"bash",
		{ command: "go test ./internal/artifacts/..." },
		"ok  \tlocalaction/internal/artifacts\t0.214s",
	),
	{
		kind: "assistant",
		id: 6,
		blocks: [
			{
				kind: "text",
				text: [
					"## Summary",
					"",
					"Artifact names are built with `path.Join`, so uploads from a Windows runner use forward slashes like every other runner.",
					"",
					"- `internal/artifacts/upload.go`: `artifactName` uses `path.Join`; local file reads still use `filepath.Join`",
					"- `internal/artifacts/upload_test.go`: covers a Windows-style job name",
					"",
					"The change is committed on `fix/artifact-paths` and the tree is clean. The package tests pass on Linux. I have not run them on a Windows runner.",
				].join("\n"),
			},
		],
		usage: turnUsage(8_440, 329, 7_920),
		ttft: 650,
		duration: 6_120,
	},
];

// ---------------------------------------------------------------------------
// nixos-config (Nix flakes and home-manager).
// ---------------------------------------------------------------------------

/** nixos-config main: desktop-only home-manager modules move into a per-host module. */
const nixosMain: ChatItem[] = [
	{
		kind: "user",
		id: 1,
		text: "The shared home-manager module still installs desktop-only packages, so the laptop gets Discord, Steam and Hyprland it never uses. Move the desktop parts into their own module and import it from the desktop host.",
	},
	{
		kind: "assistant",
		id: 2,
		blocks: [
			{
				kind: "thinking",
				text: "The shared module imports the GUI packages for every host. A per-host module keeps the split explicit and leaves the shared module with what every host needs.",
			},
			{
				kind: "text",
				text: "I'll find the desktop-only lines, move them into a desktop module, and wire that module into the desktop host.",
			},
		],
		usage: turnUsage(11_050, 302, 10_480),
		ttft: 718,
		duration: 4_460,
	},
	tool(
		3,
		"grep",
		{ pattern: "discord|steam|hyprland", path: "home" },
		lines(
			"home/default.nix:14:    discord",
			"home/default.nix:15:    steam",
			"home/default.nix:19:  wayland.windowManager.hyprland.enable = true;",
		),
	),
	tool(
		4,
		"edit",
		{
			path: "home/default.nix",
			edits: [
				{
					oldText: lines(
						"    discord",
						"    steam",
						"    ripgrep",
						"  ];",
						"",
						"  wayland.windowManager.hyprland.enable = true;",
					),
					newText: lines("    ripgrep", "  ];"),
				},
			],
		},
		"Applied 1 edit to home/default.nix",
	),
	tool(
		5,
		"write",
		{
			path: "home/hosts/desktop.nix",
			content: lines(
				"{ pkgs, ... }:",
				"",
				"{",
				"  home.packages = with pkgs; [",
				"    discord",
				"    steam",
				"  ];",
				"",
				"  wayland.windowManager.hyprland.enable = true;",
				"}",
			),
		},
		"Wrote 10 lines to home/hosts/desktop.nix",
	),
	tool(
		6,
		"edit",
		{
			path: "hosts/desktop/default.nix",
			edits: [
				{
					oldText: lines("  imports = [", "    ../../home", "  ];"),
					newText: lines(
						"  imports = [",
						"    ../../home",
						"    ../../home/hosts/desktop.nix",
						"  ];",
					),
				},
			],
		},
		"Applied 1 edit to hosts/desktop/default.nix",
	),
	{
		kind: "assistant",
		id: 7,
		blocks: [
			{
				kind: "text",
				text: [
					"## Summary",
					"",
					"Desktop-only packages and Hyprland now live in `home/hosts/desktop.nix`, and the desktop host imports it. The shared `home/default.nix` keeps only what every host uses.",
					"",
					"| File | Change |",
					"| --- | --- |",
					"| `home/default.nix` | desktop packages and Hyprland removed |",
					"| `home/hosts/desktop.nix` | new, desktop packages and Hyprland |",
					"| `hosts/desktop/default.nix` | imports the desktop module |",
					"",
					"The laptop no longer gets Discord, Steam or Hyprland from the shared module, which is the intent. `nix flake check` has not run yet.",
				].join("\n"),
			},
		],
		usage: turnUsage(14_212, 760, 13_600),
		ttft: 694,
		duration: 9_010,
	},
];

/** nixos-config flake-update (asleep): the overlay is rewritten for the new nixpkgs; flake.lock waits for it to build. */
const nixosFlake: ChatItem[] = [
	{
		kind: "user",
		id: 1,
		text: "The last nixpkgs update broke the ripgrep and fzf overlays, so the hosts no longer build. Bump nixpkgs and fix the overlays so the flake builds again.",
	},
	{
		kind: "assistant",
		id: 2,
		blocks: [
			{
				kind: "thinking",
				text: "Both overlays patch packages that moved in the newer nixpkgs. The ripgrep patch landed upstream, the fzf patch still applies, and the wrapper can go.",
			},
			{
				kind: "text",
				text: "I'll find the overlay block, read it, and rewrite it against the new nixpkgs. The flake.lock bump waits until the overlay builds.",
			},
		],
		usage: turnUsage(6_712, 160, 6_240),
		ttft: 760,
		duration: 3_320,
	},
	tool(
		3,
		"grep",
		{ pattern: "patches|overrideAttrs", path: "overlays" },
		lines(
			"overlays/default.nix:3:  ripgrep = prev.ripgrep.overrideAttrs (old: {",
			"overlays/default.nix:4:    patches = [ ./patches/rg-ignore.patch ];",
			"overlays/default.nix:10:  fzf = prev.fzf.overrideAttrs (old: {",
			"overlays/default.nix:11:    patches = [ ./patches/fzf-tmux.patch ];",
		),
	),
	tool(
		4,
		"read",
		{ path: "overlays/default.nix", offset: 3, limit: 18 },
		lines(
			"3→  ripgrep = prev.ripgrep.overrideAttrs (old: {",
			"4→    patches = [ ./patches/rg-ignore.patch ];",
			"5→    postInstall = ''",
			"6→      installShellCompletion --bash complete/rg.bash",
			"7→    '';",
			"8→  });",
			"9→",
			"10→  fzf = prev.fzf.overrideAttrs (old: {",
			"11→    patches = [ ./patches/fzf-tmux.patch ];",
			"12→    postPatch = ''",
			'13→      substituteInPlace src/terminal.go --replace-fail "tmux" "tmux-3.4"',
			"14→    '';",
			"15→  });",
			"16→",
			"17→  # Pinned to the old nixpkgs; the wrapper works around the broken fzf rev.",
			"18→  fzf-wrapper = prev.writeShellScriptBin \"fzf\" ''",
			'19→    exec ${prev.fzf}/bin/fzf "$@"',
			"20→  '';",
		),
	),
	tool(
		5,
		"edit",
		{
			path: "overlays/default.nix",
			edits: [
				{
					oldText: lines(
						"  ripgrep = prev.ripgrep.overrideAttrs (old: {",
						"    patches = [ ./patches/rg-ignore.patch ];",
						"    postInstall = ''",
						"      installShellCompletion --bash complete/rg.bash",
						"    '';",
						"  });",
						"",
						"  fzf = prev.fzf.overrideAttrs (old: {",
						"    patches = [ ./patches/fzf-tmux.patch ];",
						"    postPatch = ''",
						'      substituteInPlace src/terminal.go --replace-fail "tmux" "tmux-3.4"',
						"    '';",
						"  });",
						"",
						"  # Pinned to the old nixpkgs; the wrapper works around the broken fzf rev.",
						"  fzf-wrapper = prev.writeShellScriptBin \"fzf\" ''",
						'    exec ${prev.fzf}/bin/fzf "$@"',
						"  '';",
					),
					newText: lines(
						"  # ripgrep ships the ignore-file fix upstream now, so its patch is gone.",
						"  ripgrep = prev.ripgrep;",
						"",
						"  # fzf keeps its tmux patch; it applies cleanly on nixpkgs 25.05.",
						"  fzf = prev.fzf.overrideAttrs (old: {",
						"    patches = [ ./patches/fzf-tmux.patch ];",
						"    postPatch = ''",
						'      substituteInPlace src/terminal.go --replace-fail "tmux" "tmux-3.4"',
						"    '';",
						"  });",
						"",
						"  # The wrapper worked around the old fzf rev; nixpkgs 25.05 does not need it.",
						"  fzf-wrapper = final.fzf;",
						"",
						"  # Completions come from nixpkgs now, so the old ripgrep hook is gone.",
						"  ripgrep-completions = prev.runCommand \"ripgrep-completions\" { } ''",
						"    install -Dm644 ${prev.ripgrep}/share/bash-completion/completions/rg $out/share/bash-completion/completions/rg",
						"  '';",
					),
				},
			],
		},
		"Applied 1 edit to overlays/default.nix",
	),
	{
		kind: "assistant",
		id: 6,
		blocks: [
			{
				kind: "text",
				text: [
					"## Summary",
					"",
					"The rewritten overlay targets nixpkgs 25.05: ripgrep ships the fix upstream, and the fzf tmux patch still applies there. The old fzf wrapper is gone.",
					"",
					"- `overlays/default.nix` is the only file changed",
					"- `flake.lock` still points at the old nixpkgs rev",
					"",
					"I left `flake.lock` alone so the overlay change can be checked on its own. The nixpkgs bump lands once `nix flake check` passes against the new overlay.",
				].join("\n"),
			},
		],
		usage: turnUsage(7_908, 288, 7_360),
		ttft: 672,
		duration: 6_540,
	},
];

/** Every App view session, keyed by roster daemonId; `dmn_a002` restores the rich screen transcript unchanged. */
export const appSessions: Record<string, AppSession> = {
	[SCREEN_DAEMON_ID]: { view: screenSessionView, items: screenItems },
	dmn_a001: session("dmn_a001", "sess_4b7e10", ompWebMain),
	dmn_a003: session("dmn_a003", "sess_c2d918", ompWebReview),
	dmn_b001: session("dmn_b001", "sess_e61a3f", localactionMain),
	dmn_b003: session("dmn_b003", "sess_07f2c4", localactionMatrix),
	dmn_b004: session("dmn_b004", "sess_9d3b65", localactionArtifacts),
	dmn_d001: session("dmn_d001", "sess_2a8c71", nixosMain),
	dmn_d002: session("dmn_d002", "sess_f5e0b9", nixosFlake),
};

/** Session files are named by their start time (`2026-10-09T09-40-12.jsonl`, UTC). */
function sessionFileTime(path: string): number {
	const stamp = /(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})\.jsonl$/.exec(path);
	if (stamp === null) throw new Error(`app-sessions: no timestamp in ${path}`);
	return Date.parse(`${stamp[1]}T${stamp[2]}:${stamp[3]}:${stamp[4]}Z`);
}

/** The worktree sessions dialog's `daemon_sessions` answer: the daemon's one session, so picking it is a plain attach. */
export function appDaemonSessions(daemonId: string): SessionListEntry[] {
	const session = appSessions[daemonId];
	const daemon = rosterAppDaemons.find((entry) => entry.daemonId === daemonId);
	if (session === undefined || daemon === undefined) return [];
	const { sessionFile, sessionId, sessionName, messageCount } = session.view;
	if (sessionFile === undefined || sessionId === undefined) return [];
	return [
		{
			path: sessionFile,
			id: sessionId,
			name: sessionName,
			cwd: daemon.cwd,
			modifiedAt: sessionFileTime(sessionFile),
			messageCount,
		},
	];
}
