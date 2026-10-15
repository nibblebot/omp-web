/**
 * First-run setup offer, shared by bare `omp-web` / `omp-web control`
 * (fleet/cli.ts serveCmd) and `bun run dev` (scripts/dev.ts, whose fleet
 * child has no TTY stdin and so never offers on its own).
 *
 * With no config file and an interactive stdin, verify the omp stack, then
 * ask for a data home and write its config. Strictly TTY-gated: non-interactive
 * spawners (whose stdout is parsed for the banner) never reach it, so its
 * status lines, prompts, and confirmations print to stdout.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { expandTilde, resolveConfigPath } from "./config";
import { checkOmpSetup, ompStatusLines } from "./omp-check";

/** Offer the first-run wizard when no config file exists and stdin is a TTY. */
export function shouldOfferSetup(configExists: boolean, isTty: boolean): boolean {
	return !configExists && isTty;
}

/** Absolute data-home/config/workspaces paths (defaults composed + ~ expanded). */
export function resolveBaseDirs(opts: {
	dataHome?: string;
	configPath?: string;
	workspaceDir?: string;
}): { dataHome: string; configPath: string; workspaceDir: string } {
	const dataHome = resolve(expandTilde(opts.dataHome ?? "~/.omp-web"));
	return {
		dataHome,
		configPath:
			opts.configPath !== undefined
				? resolve(expandTilde(opts.configPath))
				: join(dataHome, "config.json"),
		workspaceDir:
			opts.workspaceDir !== undefined
				? resolve(expandTilde(opts.workspaceDir))
				: join(dataHome, "workspaces"),
	};
}

/**
 * Write the fleet config file: `workspaceDir` only, no `roots` key. Unknown
 * keys are tolerated by loadConfig, so future writers stay compatible. This
 * is the ONLY writer of the config file (the first-run offer).
 */
export function writeConfigFile(configPath: string, workspaceDir: string): void {
	mkdirSync(dirname(configPath), { recursive: true });
	writeFileSync(configPath, `${JSON.stringify({ workspaceDir }, null, 2)}\n`, "utf8");
}

/** Bytes read past the last newline, kept for the next line read. */
let linePending = "";

/**
 * Write `prompt` to stdout, then read one line from stdin (EOF → ""). Plain
 * line reading (no readline): a TTY in cooked mode delivers line-buffered
 * data, but a single chunk may hold several lines; the remainder is kept in
 * `linePending` for the next read. A fresh readline interface per prompt would
 * hang (readline TTY state does not survive close/recreate on one stream).
 * stdin is paused between reads so a caller that hands the terminal to a
 * child afterwards (dev's vite inherits it) is not raced for keystrokes.
 */
function readLine(prompt: string): Promise<string> {
	process.stdout.write(prompt);
	return new Promise<string>((resolve) => {
		let buffer = linePending;
		linePending = "";
		const cleanup = () => {
			process.stdin.off("data", onData);
			process.stdin.off("end", onEnd);
			process.stdin.pause();
		};
		const flush = () => {
			const nl = buffer.indexOf("\n");
			if (nl < 0) return false;
			linePending = buffer.slice(nl + 1);
			buffer = buffer.slice(0, nl);
			cleanup();
			resolve(buffer);
			return true;
		};
		const onData = (chunk: Buffer) => {
			buffer += chunk.toString("utf8");
			flush();
		};
		const onEnd = () => {
			cleanup();
			resolve(buffer);
		};
		// Leftover from a previous read may already hold a full line.
		if (flush()) return;
		process.stdin.on("data", onData);
		process.stdin.once("end", onEnd);
		process.stdin.resume();
	});
}

/**
 * Run the first-run offer when {@link shouldOfferSetup} holds. Returns the
 * written config path (callers boot with it: a chosen data home may differ
 * from the default lookup path, and state follows the config), or undefined
 * when no offer ran or the user declined (serve with defaults, nothing written).
 */
export async function offerFirstRunSetup(workspaceDir?: string): Promise<string | undefined> {
	if (!shouldOfferSetup(existsSync(resolveConfigPath()), process.stdin.isTTY === true)) {
		return undefined;
	}
	const status = await checkOmpSetup();
	for (const line of ompStatusLines(status)) console.log(line);
	// One prompt: Enter (or y/yes) accepts the default data home, a path
	// (with a leading `~` for the home dir) overrides it, `n`/`no` declines.
	const answer = (
		await readLine("No omp-web config found. Data home directory [~/.omp-web]: ")
	).trim();
	const normalized = answer === "y" || answer === "yes" ? "" : answer;
	if (normalized === "n" || normalized === "no") return undefined;
	const dirs = resolveBaseDirs({
		dataHome: normalized === "" ? undefined : normalized,
		workspaceDir,
	});
	mkdirSync(dirs.dataHome, { recursive: true });
	mkdirSync(dirs.workspaceDir, { recursive: true });
	writeConfigFile(dirs.configPath, dirs.workspaceDir);
	console.log(`setup: data home configured at ${dirs.dataHome}`);
	console.log(`setup: config written to ${dirs.configPath}`);
	return dirs.configPath;
}
