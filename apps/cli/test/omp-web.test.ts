import { describe, expect, test } from "bun:test";
import { classifyCommand, type DispatchTarget } from "../omp-web";

describe("classifyCommand", () => {
	/** One routing table for every argv the dispatcher must place. Trailing
	 *  args ride along: classification reads argv[0], so a verb's options
	 *  never change its target. */
	const routes: Array<[string[], DispatchTarget]> = [
		[["control"], "fleet"],
		[["ui"], "fleet"],
		[["sessions"], "fleet"],
		[["projects"], "fleet"],
		[["profiles"], "fleet"],
		[["spawn"], "fleet"],
		[["add-repo"], "fleet"],
		[["enroll"], "fleet"],
		[["provision"], "fleet"],
		[["add-clone"], "fleet"],
		[["start"], "fleet"],
		[["stop"], "fleet"],
		[["remove"], "fleet"],
		[["rm-project"], "fleet"],
		[["add-worktree"], "fleet"],
		[["rm-worktree"], "fleet"],
		[["prompt"], "fleet"],
		[["preflight"], "fleet"],
		[["control", "--port", "0"], "fleet"],
		[["sessions", "--port", "4722"], "fleet"],
		[["ui", "--control-port", "4722", "--no-open"], "fleet"],
	];

	test("routes argv to its target", () => {
		for (const [argv, target] of routes) {
			expect(classifyCommand(argv)).toBe(target);
		}
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
		expect(classifyCommand(["--no-open"])).toBe("fleet");
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
