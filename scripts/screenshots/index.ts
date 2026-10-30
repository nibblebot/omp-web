#!/usr/bin/env bun
/** `bun run screenshots`: see `--help` (args.ts) for usage. */
import { join } from "node:path";
import { listShots, parseArgs, UsageError, USAGE } from "./args";
import { runScreenshots } from "./run";

const repoRoot = join(import.meta.dir, "..", "..");

async function main(): Promise<number> {
	let options;
	try {
		options = parseArgs(process.argv.slice(2));
	} catch (err) {
		if (err instanceof UsageError) {
			console.error(`${err.message}\n\n${USAGE}`);
			return 2;
		}
		throw err;
	}
	if (options.help) {
		console.log(USAGE);
		return 0;
	}
	if (options.list) {
		console.log(listShots());
		return 0;
	}
	try {
		await runScreenshots(options, repoRoot);
		return 0;
	} catch (err) {
		console.error(`screenshots: ${err instanceof Error ? err.message : String(err)}`);
		return 1;
	}
}

process.exit(await main());
