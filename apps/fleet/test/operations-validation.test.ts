/**
 * Shared semantic validation (jgc5): the clone-source rule that
 * the edge command table and the REST control API both call. Both transports
 * must reject the same inputs with the same message.
 */

import { describe, expect, test } from "bun:test";
import { OperationError, parseCloneSource } from "../operations";

function errorOf(run: () => unknown): OperationError {
	try {
		run();
	} catch (err) {
		if (err instanceof OperationError) return err;
		throw err;
	}
	throw new Error("expected an OperationError");
}

describe("parseCloneSource", () => {
	test("returns the single non-empty member", () => {
		expect(parseCloneSource({ remote: "git@host:repo.git" })).toEqual({
			remote: "git@host:repo.git",
		});
		expect(parseCloneSource({ local: "/srv/repo", remoteName: "" })).toEqual({
			local: "/srv/repo",
		});
	});

	test("rejects a non-object source (string, null, array) with the pinned message", () => {
		for (const raw of ["local", null, ["/srv/repo"]]) {
			const err = errorOf(() => parseCloneSource(raw));
			expect(err.status).toBe(400);
			expect(err.message).toBe("source must be an object");
		}
	});

	test("rejects zero or several members", () => {
		const none = errorOf(() => parseCloneSource({ remoteName: "" }));
		expect(none.message).toBe("source must set exactly one of local, remote, or remoteName");
		const two = errorOf(() => parseCloneSource({ local: "/a", remote: "b" }));
		expect(two.status).toBe(400);
		expect(two.message).toBe("source must set exactly one of local, remote, or remoteName");
	});
});
