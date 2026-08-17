/**
 * Regression tests for the transcript overhaul (wave 1, slice F):
 * tool-call pairing across page boundaries, pending-call detection,
 * manual <details> toggles surviving page appends, tool-filter scoping
 * (main view only), and honest progress math. All pure-function tests —
 * no DOM, no fixture dependency.
 */
import { describe, expect, test } from "bun:test";
// Client build: bun resolves "solid-js" to its SSR build, where memos never
// recompute; the reactive client build is what the browser (and these
// reactivity assertions) need. Types come from test/solid-dist.d.ts.
import { createMemo, createRoot, createSignal } from "solid-js/dist/solid.js";
import type { RawEntry } from "./api";
import { entryTypeLabel, shortSummary } from "./util/entries";
import { createCollapseStore } from "./components/transcript/collapse";
import { pairToolCalls, createPairingMaps } from "./components/transcript/pairing";
import {
	buildDayRows,
	filterTranscriptEntries,
	progressTotal,
} from "./components/transcript/index";

// ---------------------------------------------------------------------------
// Synthetic entry builders (mirror the fixture's JSONL shapes)
// ---------------------------------------------------------------------------

function assistantWithToolCall(id: string, toolCallId: string, name: string): RawEntry {
	return {
		type: "message",
		id,
		timestamp: "2026-01-01T10:00:00.000Z",
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id: toolCallId, name, arguments: { q: "x" } }],
		},
	};
}

function toolResult(id: string, toolCallId: string, text: string): RawEntry {
	return {
		type: "message",
		id,
		timestamp: "2026-01-01T10:00:05.000Z",
		message: { role: "toolResult", toolCallId, isError: false, content: [{ type: "text", text }] },
	};
}

function execStart(id: string, toolCallId: string, toolName: string): RawEntry {
	return {
		type: "custom",
		id,
		timestamp: "2026-01-01T10:00:04.000Z",
		customType: "tool_execution_start",
		data: { toolCallId, toolName, startedAt: "2026-01-01T10:00:04.000Z" },
	};
}

function filler(id: string): RawEntry {
	return { type: "label", id, timestamp: "2026-01-01T10:00:01.000Z", title: "filler" };
}

const CALL_START_MS = Date.parse("2026-01-01T10:00:04.000Z");

// ---------------------------------------------------------------------------
// Pairing (Phase 1 finding: pairing must span page boundaries)
// ---------------------------------------------------------------------------

describe("pairToolCalls", () => {
	test("pairs a toolResult with its call start across a page boundary", () => {
		// Page 1: execution-start marker + call message near the front of the window.
		const page1 = [
			filler("p1-1"),
			execStart("es-a", "call-a", "read"),
			assistantWithToolCall("p1-2", "call-a", "read"),
		];
		// Page 2: many entries later, the result arrives.
		const page2 = [filler("p2-1"), filler("p2-2"), toolResult("res-a", "call-a", "file contents")];

		const { calls, results } = pairToolCalls([...page1, ...page2]);

		const call = calls.get("call-a");
		expect(call).toBeDefined();
		expect(call!.name).toBe("read");
		expect(call!.startedAt).toBe(CALL_START_MS);
		expect(call!.hasResult).toBe(true);
		expect(call!.hasCall).toBe(true);
		// The result is nested under its call card (EntryRow hides it standalone).
		expect(results.get("call-a")?.map((r) => r.id)).toEqual(["res-a"]);
	});

	test("execution-start may precede the assistant message within the loaded range", () => {
		const page1 = [execStart("es-b", "call-b", "bash")];
		const page2 = [
			assistantWithToolCall("p2-b", "call-b", "bash"),
			toolResult("res-b", "call-b", "ok"),
		];
		const { calls } = pairToolCalls([...page1, ...page2]);
		const call = calls.get("call-b")!;
		expect(call.startedAt).toBe(CALL_START_MS);
		expect(call.hasCall).toBe(true);
		expect(call.hasResult).toBe(true);
	});

	test("call with execution start but no result yet in the loaded range is pending", () => {
		const { calls } = pairToolCalls([
			execStart("es-p", "call-p", "web_search"),
			assistantWithToolCall("p-p", "call-p", "web_search"),
		]);
		const call = calls.get("call-p")!;
		expect(call.hasResult).toBe(false); // drives the "pending…" badge
		expect(call.startedAt).toBe(CALL_START_MS);
	});

	test("result loaded before its call message renders standalone (hasCall false)", () => {
		const { calls } = pairToolCalls([toolResult("res-c", "call-c", "early")]);
		const call = calls.get("call-c")!;
		expect(call.hasResult).toBe(true);
		expect(call.hasCall).toBe(false); // EntryRow keeps the standalone row
	});

	test("results are collected per toolCallId and hasResult flips once a result exists", () => {
		const { calls, results } = pairToolCalls([
			assistantWithToolCall("p1", "call-d", "edit"),
			toolResult("r1", "call-d", "a"),
			toolResult("r2", "call-d", "b"),
		]);
		expect(results.get("call-d")?.map((r) => r.id)).toEqual(["r1", "r2"]);
		expect(calls.get("call-d")!.hasResult).toBe(true);
	});

	test("pairing memo recomputes once per entries change (never per row)", () => {
		let computes = 0;
		const root = createRoot((dispose) => {
			const [entries, setEntries] = createSignal<RawEntry[]>([]);
			const pairing = createMemo(() => {
				computes += 1;
				return pairToolCalls(entries());
			});
			return { pairing, setEntries, dispose };
		});

		const page1 = [
			execStart("es-a", "call-a", "read"),
			assistantWithToolCall("p1-2", "call-a", "read"),
		];
		const page2 = [filler("p2-1"), toolResult("res-a", "call-a", "file contents")];

		expect(computes).toBeGreaterThanOrEqual(0);
		const before = computes;
		root.setEntries(page1);
		expect(root.pairing().calls.get("call-a")!.hasResult).toBe(false);
		expect(computes).toBe(before + 1);
		// Page 2 appends → ONE recompute; the result now pairs with page 1's call.
		root.setEntries([...page1, ...page2]);
		expect(root.pairing().calls.get("call-a")).toMatchObject({
			hasResult: true,
			startedAt: CALL_START_MS,
		});
		expect(computes).toBe(before + 2);
		root.dispose();
	});
});

// ---------------------------------------------------------------------------
// Collapse state (Phase 3 finding: toggle-all must not clobber manual toggles)
// ---------------------------------------------------------------------------

describe("collapse store", () => {
	test("manual <details> toggle survives a page append without re-applying toggle-all", () => {
		const s = createCollapseStore();
		s.ctx.setDetailsOpen("e1:tc-args:0", true);
		expect(s.ctx.detailsOpen("e1:tc-args:0")).toBe(true);

		// Page append mounts new rows: expandAll is null → untouched defaults (closed).
		expect(s.ctx.detailsOpen("e2:tc-args:0")).toBe(false);
		expect(s.ctx.detailsOpen("e1:tc-args:0")).toBe(true); // manual state kept
	});

	test("expand-all then manual collapse: appends follow expand-all, manual stays closed", () => {
		const s = createCollapseStore();
		s.expandEverything();
		s.ctx.setDetailsOpen("e1:raw", false); // user re-collapses one manually
		// New page arrives:
		expect(s.ctx.detailsOpen("e2:raw")).toBe(true); // follows expand-all
		expect(s.ctx.detailsOpen("e1:raw")).toBe(false); // manual toggle NOT clobbered
	});

	test("collapse-all closes every details and collapses every card id", () => {
		const s = createCollapseStore();
		s.ctx.setDetailsOpen("e1:raw", true);
		s.collapseEverything(["e1", "e2", ""]);
		expect(s.ctx.detailsOpen("e1:raw")).toBe(false);
		expect(s.ctx.collapsed("e1")).toBe(true);
		expect(s.ctx.collapsed("e2")).toBe(true);
		expect(s.ctx.collapsed("")).toBe(false); // id-less entries never collapse
	});

	test("reset clears collapse + details state on file switch", () => {
		const s = createCollapseStore();
		s.ctx.setDetailsOpen("e1:raw", true);
		s.collapseEverything(["e1"]);
		s.reset();
		expect(s.ctx.detailsOpen("e1:raw")).toBe(false);
		expect(s.ctx.collapsed("e1")).toBe(false);
		expect(s.details().expandAll).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Tool filter scoping (?tool= must not leak into subagent transcripts)
// ---------------------------------------------------------------------------

describe("filterTranscriptEntries", () => {
	const entries: RawEntry[] = [
		filler("f1"),
		assistantWithToolCall("a1", "call-web-1", "web_search"),
		toolResult("r1", "call-web-1", "hits"),
		assistantWithToolCall("a2", "call-read-1", "read"),
		toolResult("r2", "call-read-1", "code"),
	];

	test("tool filter keeps matching assistant messages, their results, and system rows", () => {
		const out = filterTranscriptEntries(entries, "web_search", false);
		expect(out.map((e) => e.id)).toEqual(["f1", "a1", "r1"]);
	});

	test("subagent view passes a null filter — nothing is filtered out", () => {
		const out = filterTranscriptEntries(entries, null, false);
		expect(out).toHaveLength(5);
	});

	test("hide-system drops non-message rows", () => {
		const out = filterTranscriptEntries(entries, null, true);
		expect(out.map((e) => e.id)).toEqual(["a1", "r1", "a2", "r2"]);
	});

	test("result without its call in the window is dropped by the filter", () => {
		const out = filterTranscriptEntries([toolResult("orphan", "call-x", "x")], "web_search", false);
		expect(out).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Progress honesty ("N of M entries", totalLines lands in a later wave)
// ---------------------------------------------------------------------------

describe("progressTotal", () => {
	test("reports the API's raw line total", () => {
		expect(progressTotal({ totalLines: 450 }, 400)).toBe(450);
	});

	test("initial page without meta reports the loaded count", () => {
		expect(progressTotal(null, 200)).toBe(200);
	});
});

// ---------------------------------------------------------------------------
// Day-group separators (virtual rows, not entries)
// ---------------------------------------------------------------------------

describe("buildDayRows", () => {
	// Local-noon epoch ms — the day change holds in any timezone.
	const noon = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12).getTime();
	const msgAt = (id: string, ts: number): RawEntry => ({
		type: "message",
		id,
		timestamp: ts,
		message: { role: "user", content: [{ type: "text", text: id }] },
	});

	test("inserts a day separator when the local calendar day changes", () => {
		const rows = buildDayRows([
			msgAt("d1a", noon(2026, 2, 1)),
			msgAt("d1b", noon(2026, 2, 1) + 3_600_000),
			msgAt("d2a", noon(2026, 2, 2)),
		]);
		expect(rows.map((r) => r.kind)).toEqual(["entry", "entry", "day", "entry"]);
		const sep = rows[2];
		if (!sep || sep.kind !== "day") throw new Error("expected a day separator row");
		expect(sep.ts).toBe(noon(2026, 2, 2));
		expect(sep.label.length).toBeGreaterThan(0);
	});

	test("no separator between same-day consecutive entries", () => {
		const rows = buildDayRows([
			msgAt("a", noon(2026, 2, 1)),
			msgAt("b", noon(2026, 2, 1) + 60_000),
		]);
		expect(rows.map((r) => r.kind)).toEqual(["entry", "entry"]);
	});

	test("no separator before the first dated entry", () => {
		expect(buildDayRows([msgAt("a", noon(2026, 2, 1))]).map((r) => r.kind)).toEqual(["entry"]);
	});

	test("undated leading rows never produce a spurious separator", () => {
		const undated: RawEntry = { type: "title", title: "T", updatedAt: "2026-02-01T10:00:00.000Z" };
		const rows = buildDayRows([
			undated,
			msgAt("h", noon(2026, 2, 1)),
			msgAt("d2", noon(2026, 2, 2)),
		]);
		expect(rows.map((r) => r.kind)).toEqual(["entry", "entry", "day", "entry"]);
	});

	test("null timestamps never separate and never reset the running day", () => {
		const undated: RawEntry = { type: "label", id: "undated", label: "?" };
		const rows = buildDayRows([
			msgAt("d1", noon(2026, 2, 1)),
			undated,
			msgAt("d2", noon(2026, 2, 2)),
		]);
		// The undated row sits between the days without emitting a separator;
		// the day change still separates the dated rows that follow it.
		expect(rows.map((r) => r.kind)).toEqual(["entry", "entry", "day", "entry"]);
	});

	test("separators are rows, not entries — entry rows preserve every entry", () => {
		const entries = [msgAt("a", noon(2026, 2, 1)), msgAt("b", noon(2026, 2, 2))];
		const rows = buildDayRows(entries);
		const entryRows = rows.filter((r) => r.kind === "entry");
		expect(entryRows).toHaveLength(entries.length);
		expect(rows).toHaveLength(entries.length + 1);
	});
});

// ---------------------------------------------------------------------------
// aria-label helpers
// ---------------------------------------------------------------------------

describe("entry labels", () => {
	test("entryTypeLabel + shortSummary compose the row aria-label", () => {
		expect(entryTypeLabel(assistantWithToolCall("a", "c1", "bash"))).toBe("assistant");
		expect(shortSummary(assistantWithToolCall("a", "c1", "bash"))).toBe("[bash]");
		expect(entryTypeLabel(toolResult("r", "c1", "done"))).toBe("toolResult");
		expect(shortSummary(toolResult("r", "c1", "done"))).toBe("done");
		expect(entryTypeLabel(filler("f"))).toBe("label");
		// systemDetail joins the entry's title with its id.
		expect(shortSummary(filler("f"))).toBe("filler · f");
	});

	test("shortSummary truncates long text", () => {
		const e = toolResult("r", "c1", "x".repeat(200));
		expect(shortSummary(e)).toBe(`${"x".repeat(60)}…`);
	});
});
