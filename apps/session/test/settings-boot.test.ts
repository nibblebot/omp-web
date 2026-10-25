import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "../../..");
const bootModule = path.join(repoRoot, "apps/session/settings-boot.ts");
const advisorSettingsModule = path.join(
	repoRoot,
	"node_modules/@oh-my-pi/pi-coding-agent/src/advisor/settings.ts",
);

// A session-like process: boots settings with the real helper, then reports each time the
// advisor switch reads true. Settings is process-global, so this runs in its own process.
const CHILD = `
const { initSettings } = await import(${JSON.stringify(bootModule)});
const { cfgAdvisorEnabled } = await import(${JSON.stringify(advisorSettingsModule)});
const settings = await initSettings({ cwd: process.env.BOOT_CWD, agentDir: process.env.BOOT_AGENT_DIR });
console.log("ready advisor=" + cfgAdvisorEnabled.get(settings));
cfgAdvisorEnabled.listen(settings, (value) => {
	if (value) console.log("advisor-on");
});
setInterval(() => {}, 1000);
`;

test("a config.yml edit made by another process reaches the running settings", async () => {
	const agentDir = mkdtempSync(path.join(tmpdir(), "omp-settings-boot-agent-"));
	const cwd = mkdtempSync(path.join(tmpdir(), "omp-settings-boot-cwd-"));
	const configPath = path.join(agentDir, "config.yml");
	writeFileSync(configPath, "advisor:\n  enabled: false\n");

	const child = Bun.spawn([process.execPath, "-e", CHILD], {
		cwd: repoRoot,
		env: { ...process.env, BOOT_AGENT_DIR: agentDir, BOOT_CWD: cwd },
		stdout: "pipe",
		stderr: "pipe",
	});
	try {
		const lines = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
		let buffered = "";
		const nextLine = async (): Promise<string> => {
			for (;;) {
				const newline = buffered.indexOf("\n");
				if (newline !== -1) {
					const line = buffered.slice(0, newline);
					buffered = buffered.slice(newline + 1);
					return line;
				}
				const { value, done } = await lines.read();
				if (done) throw new Error("child exited before reporting");
				buffered += value;
			}
		};

		expect(await nextLine()).toBe("ready advisor=false");

		// Another process (the fleet) enables the advisor in the same config file.
		writeFileSync(configPath, "advisor:\n  enabled: true\n");

		expect(await nextLine()).toBe("advisor-on");
	} finally {
		child.kill();
	}
});
