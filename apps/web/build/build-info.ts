import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Build-time identity for the web bundle, injected as `define` constants
 * (read back by apps/web/build-info.ts). Shared by vite.config.ts and the
 * design-system server so both bundles carry the same stamp.
 *
 * - omp-web version: the root package.json `version`.
 * - git hash: `git rev-parse --short HEAD` at build time; empty outside a
 *   checkout.
 * - omp version: the root package.json pin of `@oh-my-pi/pi-coding-agent`.
 *   The SDK packages are pinned exactly, so the pin is the version sessions
 *   run.
 */
export function buildInfoDefines(repoRoot: string): Record<string, string> {
	const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
		version?: unknown;
		dependencies?: Record<string, unknown>;
	};
	const omp = pkg.dependencies?.["@oh-my-pi/pi-coding-agent"];
	return {
		__OMP_WEB_BUILD_VERSION__: JSON.stringify(typeof pkg.version === "string" ? pkg.version : ""),
		__OMP_WEB_BUILD_GIT_HASH__: JSON.stringify(gitHash(repoRoot)),
		__OMP_WEB_BUILD_OMP_VERSION__: JSON.stringify(typeof omp === "string" ? omp : ""),
	};
}

function gitHash(cwd: string): string {
	try {
		return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return "";
	}
}
