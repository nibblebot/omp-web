/**
 * The approval bar's rows: which answers a prompt offers, in what order, and what each
 * row sends back; plus the title/details split of the prompt text.
 */
import { describe, expect, test } from "bun:test";
import { approvalChoices, splitApprovalPrompt } from "../../prompt/approval";

describe("approvalChoices", () => {
	test("a bare prompt offers Approve and Deny", () => {
		expect(approvalChoices({ full: "Allow tool: bash" }).map((c) => [c.label, c.answer])).toEqual([
			["Approve", "once"],
			["Deny", "deny"],
		]);
	});

	test("the session choice appears with the prompt's own label, before Deny", () => {
		const labels = approvalChoices({
			full: "Allow tool: bash",
			session: "Approve bash for this session",
		}).map((c) => c.label);
		expect(labels).toEqual(["Approve", "Approve bash for this session", "Deny"]);
	});

	test("grants list session then always variants and rename Approve to Approve Once", () => {
		const choices = approvalChoices({
			full: "Allow tool: write",
			session: "Approve write for this session",
			grants: [
				{
					scope: "folder",
					label: "Approve Directory: src",
					alwaysLabel: "Always Approve Directory: src",
				},
				{ scope: "target", label: "Approve File", alwaysLabel: "Always Approve File" },
			],
		});
		expect(choices.map((c) => [c.label, c.answer])).toEqual([
			["Approve Once", "once"],
			["Approve write for this session", "session"],
			["Approve Directory: src", { grant: "folder", always: false }],
			["Approve File", { grant: "target", always: false }],
			["Always Approve Directory: src", { grant: "folder", always: true }],
			["Always Approve File", { grant: "target", always: true }],
			["Deny", "deny"],
		]);
		expect(choices[2]?.detail).toBe("Remembered for this session");
		expect(choices[4]?.detail).toBe("Remembered across sessions");
	});
});

describe("splitApprovalPrompt", () => {
	test("the first line is the title; the rest keeps its whitespace", () => {
		expect(splitApprovalPrompt("Allow tool: write\nPath: a\n  indented\n")).toEqual({
			title: "Allow tool: write",
			details: "Path: a\n  indented\n",
		});
	});

	test("a one-line prompt has no details", () => {
		expect(splitApprovalPrompt("Allow tool: bash")).toEqual({
			title: "Allow tool: bash",
			details: "",
		});
	});
});
