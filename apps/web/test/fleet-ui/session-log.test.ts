import { describe, expect, test } from "bun:test";
import { filterStderr } from "../../fleet-ui/session-log";

const TAIL = [
	'OMP_SESSION|{"event":"listening"}',
	"callback pair connecting",
	"callback pair ready",
	"[d1] warn: provider rate limit near",
	"fatal: boom",
].join("\n");

describe("filterStderr", () => {
	test("errorsOnly off returns the tail verbatim", () => {
		expect(filterStderr(TAIL, false)).toBe(TAIL);
	});

	test("errorsOnly keeps only warning and error lines, dropping callback chatter", () => {
		expect(filterStderr(TAIL, true)).toBe("[d1] warn: provider rate limit near\nfatal: boom");
	});

	test("errorsOnly with no triage lines yields the empty string", () => {
		expect(filterStderr("callback pair ready\nOMP_SESSION|resumed", true)).toBe("");
	});

	test("empty tail stays empty in both modes", () => {
		expect(filterStderr("", false)).toBe("");
		expect(filterStderr("", true)).toBe("");
	});
});
