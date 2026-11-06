import type { ShellVizDto, ShellVizRowDto } from "#lib/wire/protocol";
import type { ToolItem } from "../../web/state";
import type { CallHandlers } from "../session";
import { argRecord } from "./subagents";

/** An available `getShellVisualization` answer. */
export type ShellVizFixture = Extract<ShellVizDto, { available: true }>;

/**
 * Answers of the session's own presentation engine for two real bash runs (captured from the SDK's
 * embedded shell): a loop with variables and a failing `curl`, and a build whose
 * commands exit 1.
 */
export const shellVizRetryScript =
	'attempts=0\nfor host in api.example.test cache.example.test; do\n  attempts=$((attempts+1))\n  if ! curl -fsS --max-time 2 "https://$host/health" > /dev/null; then\n    echo "$host is down" >&2\n  fi\ndone\necho "checked $attempts hosts"';
export const shellVizRetry: ShellVizFixture = {
	available: true,
	running: false,
	status: 0,
	pseudo: [
		{
			depth: 0,
			segments: [
				{
					text: 'attempts = "0"',
					tone: "variable",
				},
			],
		},
		{
			depth: 0,
			segments: [
				{
					text: "for ",
					tone: "keyword",
				},
				{
					text: "host",
					tone: "variable",
				},
				{
					text: " in ",
					tone: "keyword",
				},
				{
					text: "[",
					tone: "operator",
				},
				{
					text: '"api.example.test"',
					tone: "string",
				},
				{
					text: ", ",
					tone: "operator",
				},
				{
					text: '"cache.example.test"',
					tone: "string",
				},
				{
					text: "]:",
					tone: "operator",
				},
			],
			meta: "↻ 2",
			variables: [
				{
					name: "host",
					value: "cache.example.test",
				},
			],
		},
		{
			depth: 1,
			segments: [
				{
					text: "attempts = (attempts + 1)",
					tone: "variable",
				},
			],
			variables: [
				{
					name: "attempts",
					value: "2",
				},
			],
		},
		{
			depth: 1,
			segments: [
				{
					text: "if not ",
					tone: "keyword",
				},
				{
					text: "curl",
					tone: "command",
					failed: true,
				},
				{
					text: ' -fsS --max-time 2 f"https://{host}/health"',
				},
				{
					text: " 🔇 out",
					tone: "accent",
				},
				{
					text: ":",
					tone: "operator",
				},
			],
			failed: true,
			effects: "⇅",
			meta: "exit 6 · ↳",
		},
		{
			depth: 2,
			segments: [
				{
					text: "print(",
					tone: "command",
				},
				{
					text: 'f"{host} is down"',
					tone: "string",
				},
				{
					text: ")",
					tone: "operator",
				},
				{
					text: " >&2",
					tone: "accent",
				},
			],
		},
		{
			depth: 0,
			segments: [
				{
					text: "print(",
					tone: "command",
				},
				{
					text: 'f"checked {attempts} hosts"',
					tone: "string",
				},
				{
					text: ")",
					tone: "operator",
				},
			],
		},
	],
	raw: [
		{
			depth: 0,
			segments: [
				{
					text: "attempts",
					tone: "variable",
				},
				{
					text: "=",
				},
				{
					text: "0",
					tone: "string",
				},
			],
		},
		{
			depth: 0,
			segments: [
				{
					text: "for",
					tone: "keyword",
				},
				{
					text: " host ",
				},
				{
					text: "in",
					tone: "keyword",
				},
				{
					text: " api.example.test cache.example.test",
				},
				{
					text: ";",
					tone: "operator",
				},
				{
					text: " ",
				},
				{
					text: "do",
					tone: "keyword",
				},
			],
			variables: [
				{
					name: "host",
					value: "cache.example.test",
				},
			],
		},
		{
			depth: 0,
			segments: [
				{
					text: "  ",
				},
				{
					text: "attempts",
					tone: "variable",
				},
				{
					text: "=",
				},
				{
					text: "$((attempts+1))",
					tone: "string",
				},
			],
			variables: [
				{
					name: "attempts",
					value: "2",
				},
			],
		},
		{
			depth: 0,
			segments: [
				{
					text: "  ",
				},
				{
					text: "if",
					tone: "keyword",
				},
				{
					text: " ! ",
				},
				{
					text: "curl",
					tone: "command",
					failed: true,
				},
				{
					text: " -fsS --max-time 2 ",
				},
				{
					text: '"https://$host/health"',
					tone: "variable",
				},
				{
					text: " > ",
				},
				{
					text: "/dev/null",
					tone: "string",
				},
				{
					text: ";",
					tone: "operator",
				},
				{
					text: " ",
				},
				{
					text: "then",
					tone: "keyword",
				},
			],
			failed: true,
			effects: "⇅",
			meta: "exit 6 · 86ms",
		},
		{
			depth: 0,
			segments: [
				{
					text: "    ",
				},
				{
					text: "echo",
					tone: "command",
				},
				{
					text: " ",
				},
				{
					text: '"$host is down"',
					tone: "variable",
				},
				{
					text: " >",
				},
				{
					text: "&",
					tone: "operator",
				},
				{
					text: "2",
					tone: "string",
				},
			],
		},
		{
			depth: 0,
			segments: [
				{
					text: "  ",
				},
				{
					text: "fi",
					tone: "keyword",
				},
			],
		},
		{
			depth: 0,
			segments: [
				{
					text: "done",
					tone: "keyword",
				},
			],
		},
		{
			depth: 0,
			segments: [
				{
					text: "echo",
					tone: "command",
				},
				{
					text: " ",
				},
				{
					text: '"checked $attempts hosts"',
					tone: "variable",
				},
			],
		},
	],
	timeline: {
		length: 49,
		cursor: 49,
		elapsedNs: 86960723,
		durationNs: 86960723,
	},
};

export const shellVizBuildScript =
	"bun run build 2>&1 | tail -n 5\ntest -f dist/index.js && echo built";
export const shellVizBuild: ShellVizFixture = {
	available: true,
	running: false,
	status: 1,
	pseudo: [
		{
			depth: 0,
			segments: [
				{
					text: "bun",
					tone: "command",
					failed: true,
				},
				{
					text: " run build",
				},
				{
					text: " +err ⇣ last 5",
					tone: "accent",
				},
			],
			failed: true,
			meta: "exit 1",
		},
		{
			depth: 0,
			segments: [
				{
					text: 'is_file("dist/index.js")',
					tone: "variable",
					failed: true,
				},
			],
			failed: true,
			meta: "exit 1",
		},
		{
			depth: 0,
			segments: [
				{
					text: " && echo built",
					tone: "string",
				},
			],
		},
	],
	raw: [
		{
			depth: 0,
			segments: [
				{
					text: "bun",
					tone: "command",
					failed: true,
				},
				{
					text: " run build 2>",
				},
				{
					text: "&",
					tone: "operator",
				},
				{
					text: "1",
					tone: "string",
				},
				{
					text: " ",
				},
				{
					text: "|",
					tone: "operator",
				},
				{
					text: " ",
				},
				{
					text: "tail",
					tone: "command",
				},
				{
					text: " -n 5",
				},
			],
			meta: "exit 1",
		},
		{
			depth: 0,
			segments: [
				{
					text: "test",
					tone: "command",
					failed: true,
				},
				{
					text: " -f ",
				},
				{
					text: "dist/index.js",
					tone: "string",
				},
				{
					text: " ",
				},
				{
					text: "&&",
					tone: "operator",
				},
				{
					text: " echo built",
				},
			],
			failed: true,
			meta: "exit 1",
		},
	],
	timeline: {
		length: 19,
		cursor: 19,
		elapsedNs: 3715555,
		durationNs: 3715555,
	},
};

/** A cut answer: rows past the budget left out of both renderings, replay history trimmed. */
export const shellVizTruncated: ShellVizFixture = {
	...structuredClone(shellVizRetry),
	omittedRows: { pseudo: 2840, raw: 2 },
	historyTrimmed: true,
};

/** The same run caught mid-flight: no status yet, the loop body executing, every other row faint. */
export const shellVizRunning: ShellVizFixture = (() => {
	const view = structuredClone(shellVizRetry);
	const active = 2;
	const mark = (rows: ShellVizRowDto[]): ShellVizRowDto[] =>
		rows.map((row, index) => {
			const { failed: _failed, gutter: _gutter, meta: _meta, ...rest } = row;
			return index === active
				? { ...rest, gutter: "active" as const }
				: { ...rest, dim: true as const };
		});
	const { status: _status, ...rest } = view;
	return {
		...rest,
		running: true,
		pseudo: mark(view.pseudo),
		raw: view.raw.map((row) => ({ ...row, dim: true as const })),
		timeline: { ...view.timeline, cursor: 21, elapsedNs: 31_000_000 },
	};
})();

/** The answer for a call the session has no visualization for (a result from before SDK 18.17.0). */
export const shellVizUnavailable: ShellVizDto = { available: false, reason: "no_trace" };

/** `view` replayed to `cursor` history records: rows past the step have not run, so their notes, marks and values are gone. */
export function shellVizReplayAt(view: ShellVizFixture, cursor: number): ShellVizFixture {
	const { length } = view.timeline;
	const at = Math.min(length, Math.max(0, cursor));
	if (at >= length) return view;
	const reached = Math.ceil((view.pseudo.length * at) / length);
	return {
		...view,
		pseudo: view.pseudo.map((row, index) => {
			if (index < reached) return row;
			const { failed: _failed, meta: _meta, variables: _variables, ...rest } = row;
			return { ...rest, dim: true as const };
		}),
		timeline: {
			...view.timeline,
			cursor: at,
			elapsedNs: Math.round((view.timeline.durationNs * at) / length),
		},
	};
}

/**
 * A plausible visualization of any command, for the demo: one row per script line, the command word
 * and quoted strings toned, finished with exit status 0. The demo's calls carry no real trace.
 */
export function shellVizOfCommand(command: string): ShellVizFixture {
	const rows: ShellVizRowDto[] = command.split("\n").map((line) => {
		const depth = Math.floor((line.length - line.trimStart().length) / 2);
		const parts = line.trim().split(/(\s+)/);
		const segments = parts.map((text, index) => ({
			text,
			...(index === 0 && text !== "" ? { tone: "command" as const } : {}),
			...(/^["\x27]/.test(text) ? { tone: "string" as const } : {}),
		}));
		return { depth, segments };
	});
	const last = rows[rows.length - 1];
	if (last) last.meta = "exit 0 · 12ms";
	return {
		available: true,
		running: false,
		status: 0,
		pseudo: rows,
		raw: rows,
		timeline: { length: 12, cursor: 12, elapsedNs: 12_000_000, durationNs: 12_000_000 },
	};
}

/** A bash card; a settled one carries the `details.shellTrace` marker the session leaves where it dropped the trace. */
const bashItem = (
	id: number,
	toolCallId: string,
	command: string,
	status: ToolItem["status"],
	output: string,
	marked = true,
): ToolItem => ({
	kind: "tool",
	id,
	toolCallId,
	name: "bash",
	args: { command },
	status,
	output,
	...(status !== "running"
		? {
				details: marked
					? { exitCode: status === "error" ? 1 : 0, shellTrace: true }
					: { exitCode: 0 },
			}
		: {}),
});

/** Bash cards whose `getShellVisualization` the stories answer (see `shellVizCalls`). */
export const shellVizDoneTool = bashItem(
	9101,
	"call_viz_retry",
	shellVizRetryScript,
	"done",
	"api.example.test is down\nchecked 2 hosts",
);
export const shellVizFailedTool = bashItem(
	9102,
	"call_viz_build",
	shellVizBuildScript,
	"error",
	"error: build failed\n\nCommand exited with code 1",
);
export const shellVizTruncatedTool = bashItem(
	9103,
	"call_viz_truncated",
	shellVizRetryScript,
	"done",
	"checked 2 hosts",
);
export const shellVizRunningTool = bashItem(
	9104,
	"call_viz_running",
	shellVizRetryScript,
	"running",
	"api.example.test is down",
);
/** Marked, yet the session has nothing to show (the call left the transcript): opening hides the control. */
export const shellVizNoTraceTool = bashItem(
	9105,
	"call_viz_notrace",
	"git status --short",
	"done",
	" M apps/web/styles/chat.css",
);
/** A result from before SDK 18.17.0: no marker, so no control at all. */
export const shellVizUnmarkedTool = bashItem(
	9106,
	"call_viz_unmarked",
	"git status --short",
	"done",
	" M apps/web/styles/chat.css",
	false,
);

/**
 * `getShellVisualization` answers by tool call id: an unlisted id is the session's `unknown_call`, a
 * `cursor` replays the fixture, as the session does for a finished run.
 */
export function shellVizCalls(answers: Record<string, ShellVizDto>): CallHandlers {
	return {
		getShellVisualization: (args) => {
			const { toolCallId, cursor } = argRecord(args);
			const answer = typeof toolCallId === "string" ? answers[toolCallId] : undefined;
			if (answer === undefined)
				return { available: false, reason: "unknown_call" } satisfies ShellVizDto;
			return answer.available && typeof cursor === "number"
				? shellVizReplayAt(answer, cursor)
				: structuredClone(answer);
		},
	};
}

/** The answers every story of the Visualize control installs. */
export const shellVizAnswers: Record<string, ShellVizDto> = {
	[shellVizDoneTool.toolCallId]: shellVizRetry,
	[shellVizFailedTool.toolCallId]: shellVizBuild,
	[shellVizTruncatedTool.toolCallId]: shellVizTruncated,
	[shellVizRunningTool.toolCallId]: shellVizRunning,
	[shellVizNoTraceTool.toolCallId]: shellVizUnavailable,
};
