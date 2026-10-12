import { describe, expect, test } from "bun:test";
import { classifyCommand } from "../omp-web";

describe("classifyCommand", () => {
	test("routes every fleet control-plane verb to fleet", () => {
		for (const verb of [
			"control",
			"ui",
			"sessions",
			"projects",
			"profiles",
			"spawn",
			"add-repo",
			"enroll",
			"provision",
			"add-clone",
			"start",
			"stop",
			"remove",
			"rm-project",
			"add-worktree",
			"rm-worktree",
			"prompt",
			"preflight",
		]) {
			expect(classifyCommand([verb])).toBe("fleet");
		}
	});

	test("keeps trailing args with the fleet verb", () => {
		expect(classifyCommand(["control", "--port", "0"])).toBe("fleet");
		expect(classifyCommand(["sessions", "--port", "4722"])).toBe("fleet");
		expect(classifyCommand(["ui", "--control-port", "4722", "--open"])).toBe("fleet");
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

	test("bare invocations and leading flags route to fleet (omp-web = serve)", () => {
		expect(classifyCommand([])).toBe("fleet");
		expect(classifyCommand([""])).toBe("fleet");
		expect(classifyCommand(["--open"])).toBe("fleet");
		expect(classifyCommand(["--port", "4800"])).toBe("fleet");
	});

	test("version flags route to version", () => {
		expect(classifyCommand(["--version"])).toBe("version");
		expect(classifyCommand(["version"])).toBe("version");
	});

	test("help flags route to help", () => {
		expect(classifyCommand(["--help"])).toBe("help");
		expect(classifyCommand(["-h"])).toBe("help");
		expect(classifyCommand(["help"])).toBe("help");
	});

	test("unknown invocations are usage errors", () => {
		expect(classifyCommand(["bogus"])).toBe("usage");
		expect(classifyCommand(["serve"])).toBe("usage");
		expect(classifyCommand(["setup"])).toBe("usage");
		expect(classifyCommand(["sessionn"])).toBe("usage");
		expect(classifyCommand(["add", "worker", "https://x"])).toBe("usage");
	});
});
