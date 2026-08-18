import { describe, expect, test } from "bun:test";
import { classifyCommand } from "./omp-web";

describe("classifyCommand", () => {
	test("routes every fleet control-plane verb to fleet", () => {
		for (const verb of [
			"serve",
			"sessions",
			"projects",
			"spawn",
			"add-repo",
			"add",
			"provision",
			"stop",
			"remove",
			"rm-project",
			"add-worktree",
			"rm-worktree",
			"prompt",
		]) {
			expect(classifyCommand([verb])).toBe("fleet");
		}
	});

	test("keeps trailing args with the fleet verb", () => {
		expect(classifyCommand(["serve", "--port", "0"])).toBe("fleet");
		expect(classifyCommand(["sessions", "--port", "4722"])).toBe("fleet");
	});

	test("routes the daemon token to session", () => {
		expect(classifyCommand(["session"])).toBe("session");
		expect(classifyCommand(["session", "--port", "0"])).toBe("session");
	});

	test("routes update to its own target", () => {
		expect(classifyCommand(["update"])).toBe("update");
		expect(classifyCommand(["update", "--check"])).toBe("update");
		expect(classifyCommand(["update", "--version", "0.2.0"])).toBe("update");
	});

	test("bare invocations route to fleet (omp-web = serve)", () => {
		expect(classifyCommand([])).toBe("fleet");
		expect(classifyCommand([""])).toBe("fleet");
	});

	test("version flags route to version", () => {
		expect(classifyCommand(["--version"])).toBe("version");
		expect(classifyCommand(["version"])).toBe("version");
	});

	test("unknown invocations are usage errors", () => {
		expect(classifyCommand(["bogus"])).toBe("usage");
		expect(classifyCommand(["--help"])).toBe("usage");
		expect(classifyCommand(["setup"])).toBe("usage");
		expect(classifyCommand(["sessionn"])).toBe("usage");
	});
});
