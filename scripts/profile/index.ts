#!/usr/bin/env bun
/** `bun run profile`: see `--help` (args.ts) for usage. */
import { join } from "node:path";
import { parseArgs, UsageError, USAGE } from "./args";
import { ensureHarnessPinned, defaultPinPlan } from "./pinning";
import { runProfile } from "./run";

const repoRoot = join(import.meta.dir, "..", "..");

async function main(): Promise<number> {
	const argv = process.argv.slice(2);
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	let parsed;
	try {
		parsed = parseArgs(argv, repoRoot, stamp);
	} catch (err) {
		if (err instanceof UsageError) {
			console.error(`${err.message}\n\n${USAGE}`);
			return 2;
		}
		throw err;
	}
	if (parsed.help) {
		console.log(USAGE);
		return 0;
	}
	// Re-exec under taskset (harness + fake model + client on the E-cores) before any work.
	await ensureHarnessPinned(defaultPinPlan({ noPin: parsed.options.noPin }));
	const result = await runProfile(parsed.options, parsed.outRoot, repoRoot);
	return result.exitCode;
}

process.exit(await main());
