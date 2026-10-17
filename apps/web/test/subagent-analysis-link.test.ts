/**
 * ANA-08 (brnh, km9k): "Open in Analysis" link helpers. The action is shown
 * only when Analysis is on and both transcript files resolve under the
 * sessions dir; otherwise no link is produced at all.
 */
import { describe, expect, test } from "bun:test";
import { parseTxHash } from "../tx/util/route";
import { sessionHash, sessionRelFile, subagentAnalysisHash } from "../store/slices/analysis";

const DIR = "/home/u/.omp/agent/sessions";
const PARENT = `${DIR}/proj/main.jsonl`;
const SUB = `${DIR}/proj/main/0-Explore.jsonl`;
const base = { analysisEnabled: true, sessionsDir: DIR, parentFile: PARENT, subagentFile: SUB };

describe("sessionRelFile", () => {
	test("maps a file under the sessions dir to its relative path", () => {
		expect(sessionRelFile(DIR, PARENT)).toBe("proj/main.jsonl");
		expect(sessionRelFile(`${DIR}/`, PARENT)).toBe("proj/main.jsonl");
	});

	test("rejects files outside the dir, the dir itself, and traversal", () => {
		expect(sessionRelFile(DIR, "/home/u/other/main.jsonl")).toBeNull();
		expect(sessionRelFile(DIR, `${DIR}-old/main.jsonl`)).toBeNull();
		expect(sessionRelFile(DIR, DIR)).toBeNull();
		expect(sessionRelFile(DIR, `${DIR}/../secret.jsonl`)).toBeNull();
		expect(sessionRelFile(DIR, `${DIR}/a//b.jsonl`)).toBeNull();
	});

	test("an empty sessions dir maps nothing", () => {
		expect(sessionRelFile("", PARENT)).toBeNull();
	});
});

describe("subagentAnalysisHash", () => {
	test("links the subagent inside its parent when everything resolves", () => {
		expect(subagentAnalysisHash(base)).toBe(
			sessionHash("proj/main.jsonl", "proj/main/0-Explore.jsonl"),
		);
	});

	test("hidden when Analysis is off", () => {
		expect(subagentAnalysisHash({ ...base, analysisEnabled: false })).toBeNull();
	});

	test("hidden until the sessions dir is known", () => {
		expect(subagentAnalysisHash({ ...base, sessionsDir: null })).toBeNull();
	});

	test("hidden when the parent or subagent file is unknown", () => {
		expect(subagentAnalysisHash({ ...base, parentFile: undefined })).toBeNull();
		expect(subagentAnalysisHash({ ...base, subagentFile: null })).toBeNull();
		expect(subagentAnalysisHash({ ...base, subagentFile: undefined })).toBeNull();
	});

	test("hidden when either file lies outside the sessions dir", () => {
		expect(subagentAnalysisHash({ ...base, subagentFile: "/tmp/elsewhere.jsonl" })).toBeNull();
		expect(subagentAnalysisHash({ ...base, parentFile: "/tmp/main.jsonl" })).toBeNull();
	});

	test("the href parses back to the same parent and subagent", () => {
		expect(parseTxHash(subagentAnalysisHash(base) ?? "")).toEqual({
			view: "session",
			file: "proj/main.jsonl",
			sub: "proj/main/0-Explore.jsonl",
		});
	});
});
