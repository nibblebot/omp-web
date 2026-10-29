import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "#lib/testkit/temp-dir.testkit";

afterAll(cleanupTempDirs);

// The verdict lands at process exit, so each case runs the real `vite build`
// CLI in a child process over a fixture whose config uses the logger.
const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const VITE_BIN = join(REPO_ROOT, "node_modules", "vite", "bin", "vite.js");
const LOGGER_MODULE = join(REPO_ROOT, "apps", "web", "build", "fail-on-warnings.ts");

const INDEX_HTML =
	'<!doctype html><html><head></head><body><script type="module" src="/main.js"></script></body></html>\n';

/** `config` is the body of the fixture's default-exported config object. */
async function buildFixture(
	files: Record<string, string>,
	config = "",
): Promise<{ code: number; output: string }> {
	const root = realpathSync(tempDir("fail-on-warnings-"));
	for (const [path, source] of Object.entries({ "index.html": INDEX_HTML, ...files })) {
		const abs = join(root, path);
		mkdirSync(join(abs, ".."), { recursive: true });
		writeFileSync(abs, source);
	}
	writeFileSync(
		join(root, "vite.config.js"),
		`import { failOnWarningsLogger } from ${JSON.stringify(LOGGER_MODULE)};\n` +
			`export default { customLogger: failOnWarningsLogger(), build: { outDir: "dist" }, ${config} };\n`,
	);
	const child = Bun.spawn([process.execPath, VITE_BIN, "build", "--config", "vite.config.js"], {
		cwd: root,
		env: { ...process.env, NO_COLOR: "1" },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { code, output: stdout + stderr };
}

describe("failOnWarningsLogger (real vite build)", () => {
	test("a build without warnings exits 0", async () => {
		const { code, output } = await buildFixture({ "main.js": 'console.info("clean");\n' });
		expect(output).not.toContain("the web build allows none");
		expect(code).toBe(0);
	}, 60_000);

	test("a Rolldown warning during bundling fails the build", async () => {
		const { code, output } = await buildFixture({
			"main.js":
				'import { dialog } from "./dialog.js";\nconsole.info(dialog);\nvoid import("./dialog.js");\n',
			"dialog.js": 'export const dialog = "dialog";\n',
		});
		expect(output).toContain("INEFFECTIVE_DYNAMIC_IMPORT");
		expect(output).toContain("vite build logged 1 warning");
		expect(code).toBe(1);
	}, 60_000);

	test("the chunk size warning, raised by the native reporter after writing, fails the build", async () => {
		const { code, output } = await buildFixture(
			{ "main.js": `console.info(${JSON.stringify("x".repeat(4096))});\n` },
			'build: { outDir: "dist", chunkSizeWarningLimit: 1 }',
		);
		expect(output).toContain("Some chunks are larger than 1 kB");
		expect(code).toBe(1);
	}, 60_000);

	test("a plugin warning in a closing hook fails the build", async () => {
		const { code, output } = await buildFixture(
			{ "main.js": 'console.info("late");\n' },
			'plugins: [{ name: "late-warner", closeBundle() { this.warn("LATE_WARNING"); } }]',
		);
		expect(output).toContain("LATE_WARNING");
		expect(code).toBe(1);
	}, 60_000);
});
