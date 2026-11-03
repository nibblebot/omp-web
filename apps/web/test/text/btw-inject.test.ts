import { describe, expect, test } from "bun:test";
import {
	btwInjectDisplay,
	formatBtwInjectText,
	getBtwInject,
	splitBtwInject,
} from "../../text/btw-inject";

describe("splitBtwInject", () => {
	test("splits a closed block from the prose around it", () => {
		expect(splitBtwInject("Send this:\n<inject>Fix the build.</inject>\nThen stop.")).toEqual({
			before: "Send this:\n",
			inject: "Fix the build.",
			after: "\nThen stop.",
			closed: true,
		});
	});

	test("an answer without the tag is plain prose", () => {
		expect(splitBtwInject("Nothing to steer.")).toBeUndefined();
		expect(splitBtwInject("a stray </inject> close")).toBeUndefined();
	});

	test("an opener with no close runs to the end while the answer streams", () => {
		expect(splitBtwInject("Draft: <inject>Fix the bu")).toEqual({
			before: "Draft: ",
			inject: "Fix the bu",
			after: "",
			closed: false,
		});
	});

	test("the last closed block wins; a tag mentioned in prose cannot capture it", () => {
		const answer =
			"Wrap it in <inject> tags, like <inject>Real prompt.</inject> and never write </inject> elsewhere.";
		const parts = splitBtwInject(answer)!;
		expect(parts.closed).toBe(true);
		expect(parts.inject).toBe("Real prompt.");
		expect(parts.before).toBe("Wrap it in <inject> tags, like ");
		expect(parts.after).toBe(" and never write </inject> elsewhere.");
	});

	test("a later unclosed opener does not hide an earlier closed block", () => {
		const parts = splitBtwInject("<inject>One.</inject> then <inject>two")!;
		expect(parts.closed).toBe(true);
		expect(parts.inject).toBe("One.");
	});
});

describe("formatBtwInjectText and getBtwInject", () => {
	test("trims the block and expands tabs to the TUI's three spaces", () => {
		expect(formatBtwInjectText("\n\tFix it\n\tnow\n")).toBe("Fix it\n   now");
	});

	test("strips terminal control sequences, keeping text and newlines", () => {
		expect(formatBtwInjectText("\u001b[31mred\u001b[0m\u001b]0;title\u0007 text\u0000\nnext")).toBe(
			"red text\nnext",
		);
	});

	test("the steering prompt is the closed block, shown text and sent text alike", () => {
		expect(getBtwInject("x <inject>\n  Fix the build.\n</inject> y")).toBe("Fix the build.");
	});

	test("an unclosed or blank block has no steering prompt", () => {
		expect(getBtwInject("<inject>still streaming")).toBeUndefined();
		expect(getBtwInject("<inject>  \n </inject>")).toBeUndefined();
		expect(getBtwInject("no block")).toBeUndefined();
	});
});

describe("btwInjectDisplay", () => {
	const idle = { sending: false, failed: false };

	test("a turn the session never offered shows no block", () => {
		expect(btwInjectDisplay(undefined, idle)).toBeUndefined();
		expect(btwInjectDisplay(undefined, { sending: true, failed: true })).toBeUndefined();
	});

	test("pending becomes sending while this page sends, and failed after a refusal", () => {
		expect(btwInjectDisplay("pending", idle)).toBe("pending");
		expect(btwInjectDisplay("pending", { sending: true, failed: false })).toBe("sending");
		expect(btwInjectDisplay("pending", { sending: false, failed: true })).toBe("failed");
	});

	test("a send in flight from another page shows as sending", () => {
		expect(btwInjectDisplay("sending", idle)).toBe("sending");
	});

	test("what the session sent stays sent, whatever this page last saw", () => {
		expect(btwInjectDisplay("sent", idle)).toBe("sent");
		expect(btwInjectDisplay("sent", { sending: true, failed: true })).toBe("sent");
	});
});
