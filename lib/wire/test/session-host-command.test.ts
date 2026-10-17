import { describe, expect, test } from "bun:test";
import { formatSessionHostCommand, readSessionEnrollment } from "../session-host-command";

const ENROLLMENT = {
	workspaceId: "ws-1",
	generation: 3,
	token: "tok-abc",
	callbackUrl: "https://fleet.example/callback",
};

describe("formatSessionHostCommand", () => {
	test("builds the session command with token, callback, workspace, and generation", () => {
		expect(formatSessionHostCommand(ENROLLMENT, "/srv/app")).toBe(
			"OMP_SESSION_CALLBACK_TOKEN=tok-abc omp-web session --cwd /srv/app --port 0" +
				" --callback-url https://fleet.example/callback --callback-workspace ws-1" +
				" --callback-generation 3",
		);
	});

	test("defaults cwd to the current directory and adds allow-http only for http callbacks", () => {
		const http = { ...ENROLLMENT, callbackUrl: "http://127.0.0.1:4722/callback" };
		expect(formatSessionHostCommand(http)).toBe(
			"OMP_SESSION_CALLBACK_TOKEN=tok-abc omp-web session --cwd . --port 0" +
				" --callback-url http://127.0.0.1:4722/callback --callback-workspace ws-1" +
				" --callback-generation 3 --callback-allow-http",
		);
	});
});

describe("readSessionEnrollment", () => {
	test("returns the enrollment from a /ctl/enroll body", () => {
		expect(readSessionEnrollment({ entry: {}, enrollment: ENROLLMENT })).toEqual(ENROLLMENT);
	});

	test("returns undefined for a malformed or missing enrollment", () => {
		expect(readSessionEnrollment({ entry: {} })).toBeUndefined();
		expect(
			readSessionEnrollment({ enrollment: { ...ENROLLMENT, generation: "3" } }),
		).toBeUndefined();
		expect(readSessionEnrollment(null)).toBeUndefined();
	});
});
