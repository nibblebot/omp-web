/**
 * Regression: the transcript's "Open in Chat" must switch the shell to Chat
 * on a unique resume (previously the click left the user in Analysis with no
 * visible change), and keep the banner text for the non-success outcomes.
 */
import { describe, expect, test } from "bun:test";
import type { ResumeResolveOutcome } from "../../store/resume";
import { openInChatEffect } from "../../tx/util/open-in-chat";

const candidate = { id: "s1" } as unknown as Extract<
	ResumeResolveOutcome,
	{ kind: "unique" }
>["session"];

describe("openInChatEffect", () => {
	test("unique resume switches to Chat with no banner", () => {
		expect(openInChatEffect({ kind: "unique", session: candidate }, "s1")).toEqual({
			view: "chat",
			error: null,
		});
	});

	test("missing names the id and searched count, stays in Analysis", () => {
		expect(openInChatEffect({ kind: "missing", searched: 4 }, "abc")).toEqual({
			view: null,
			error: "No session matches abc (4 searched).",
		});
	});

	test("refused and unknown show the outcome message, stay in Analysis", () => {
		expect(openInChatEffect({ kind: "refused", message: "not attached" }, "x")).toEqual({
			view: null,
			error: "not attached",
		});
		expect(openInChatEffect({ kind: "unknown", message: "nope" }, "x")).toEqual({
			view: null,
			error: "nope",
		});
	});

	test("ambiguous opens the sessions chooser (no view switch, no banner)", () => {
		expect(openInChatEffect({ kind: "ambiguous", candidates: [] }, "x")).toEqual({
			view: null,
			error: null,
		});
	});
});
