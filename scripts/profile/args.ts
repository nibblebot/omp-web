/** Command line parsing and `--help` text for `bun run profile`. */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { BASELINES_DIR } from "./summary";
import type { RunOptions } from "./types";

export const USAGE = `bun run profile: baseline CPU, RSS, latency and throughput of the real omp-web stack

Boots an isolated out-of-process fleet (own state, port, workspace dir under
.profile-out/run-<ts>/), real session daemons, a deterministic fake OpenAI
model and a synthetic browser client (sse+post), pins every process to its own
core, runs the scenarios, and writes summary.json + summary.md.

Scenarios (ids for --scenario):
  s1-history   sub-threshold large-history attach (3.3 MiB): TTFF and priming over repeated attaches,
               reconnect; any dropped or re-primed attach fails the rep
  s1-history-large  23 MiB history, past the edge's drop point: attach drop rate (primary) and
               completed-attach timings (biased)
  s2-text      high-rate text deltas: stream latency, command RTT under load, reconnect mid-stream
  s3-tools     tool-heavy: real bash calls with large outputs
  s4-subagents subagent fan-out
  combined     all four sessions at once, one browser attached to s2

Usage: bun run profile [options]
  --quick              liveness check, then per scenario one short (3 s) warmup rep and 1 measured
                       rep x 10 s (~2 min)
  --liveness           run only the ~3 s liveness check (exit 1 when no frames reach
                       the client, no text delta arrives, or the session never idles)
  --scenario <id>      run only this scenario (repeatable, or comma separated)
  --reps <n>           measured reps per scenario (default 5; --quick 1)
  --warmups <n>        warmup reps per scenario (default 1; with --quick a warmup lasts 3 s)
  --duration <sec>     measured window per rep (default 20; --quick 10)
  --browser            also run the Chromium pass (scenario browser-s2) through the real UI (playwright-core;
                       wall-clock latency; needs dist/, built on demand)
  --chromium-path <p>  Chromium executable for --browser (else PROFILE_CHROMIUM, the
                       Playwright cache, then chromium on PATH)
  --heap               opt-in end-of-rep JS heap read per process (starts bun with
                       --inspect; perturbs memory and timing; labeled in the summary)
  --cpuprofile         bun --cpu-prof on the fleet and every session; buckets self time into
                       JSON stringify/parse, SSE/NDJSON encode, stream enqueue/write, other.
                       Timings are perturbed and labeled; do not compare them to plain runs.
  --compare <file>     compare against a baseline summary.json (median delta vs noise band,
                       'within noise' labels; fingerprint mismatches warn; always exits 0)
  --save-baseline <n>  write .profile-out/baselines/<n>.{json,md} from this run (local, gitignored;
                       refused up front when it exists, unless --overwrite-baseline)
  --overwrite-baseline replace an existing --save-baseline
  --no-pin             skip core pinning (noisy; recorded in the summary)
  --out <dir>          output root (default .profile-out)
  --help               this text

Pinning (i9-13900KF layout, one physical P-core thread per role, SMT siblings idle):
  fleet cpu 0, sessions cpus 2/4/6/8, Chromium 10,12, fake model (own process) E-cores 16-23,
  harness (client, sampler, runner) E-cores 24-31.
  Every thread's affinity is verified before each rep and recorded.
Clocks: Bun processes stamp CLOCK_MONOTONIC via libc (clock-monotonic-ffi, one timeline
for all of them); Chromium stamps wall-clock time (chromium-wall-clock). Both labeled.
Verify a transport/wire change before merge: bun run profile --quick --compare <baseline.json>
`;

export class UsageError extends Error {}

function take(argv: string[], i: number, flag: string): string {
	const value = argv[i + 1];
	if (value === undefined || value.startsWith("--")) throw new UsageError(`${flag} needs a value`);
	return value;
}

function positive(value: string, flag: string): number {
	const n = Number(value);
	if (!Number.isFinite(n) || n <= 0) throw new UsageError(`${flag} must be a positive number`);
	return n;
}

export interface ParsedArgs {
	options: RunOptions;
	help: boolean;
	outRoot: string;
}

export function parseArgs(argv: string[], repoRoot: string, stamp: string): ParsedArgs {
	let quick = false;
	let browser = false;
	let heap = false;
	let cpuprofile = false;
	let liveness = false;
	let noPin = false;
	let help = false;
	let breakFakeModel = false;
	const scenarios: string[] = [];
	let reps: number | undefined;
	let warmups: number | undefined;
	let durationSec: number | undefined;
	let compare: string | undefined;
	let saveBaseline: string | undefined;
	let overwriteBaseline = false;
	let chromiumPath: string | undefined;
	let outRoot = join(repoRoot, ".profile-out");
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		switch (arg) {
			case "--quick":
				quick = true;
				break;
			case "--browser":
				browser = true;
				break;
			case "--heap":
				heap = true;
				break;
			case "--cpuprofile":
				cpuprofile = true;
				break;
			case "--liveness":
				liveness = true;
				break;
			case "--no-pin":
				noPin = true;
				break;
			case "--help":
			case "-h":
				help = true;
				break;
			case "--break-fake-model":
				breakFakeModel = true;
				break;
			case "--scenario":
				scenarios.push(
					...take(argv, i++, arg)
						.split(",")
						.filter((s) => s !== ""),
				);
				break;
			case "--reps":
				reps = Math.floor(positive(take(argv, i++, arg), arg));
				break;
			case "--warmups": {
				const n = Number(take(argv, i++, arg));
				if (!Number.isInteger(n) || n < 0)
					throw new UsageError("--warmups must be a non-negative integer");
				warmups = n;
				break;
			}
			case "--duration":
				durationSec = positive(take(argv, i++, arg), arg);
				break;
			case "--compare":
				compare = take(argv, i++, arg);
				break;
			case "--save-baseline":
				saveBaseline = take(argv, i++, arg);
				break;
			case "--overwrite-baseline":
				overwriteBaseline = true;
				break;
			case "--chromium-path":
				chromiumPath = take(argv, i++, arg);
				break;
			case "--out":
				outRoot = resolve(take(argv, i++, arg));
				break;
			default:
				throw new UsageError(`unknown option: ${arg} (see --help)`);
		}
	}
	const options: RunOptions = {
		quick,
		browser,
		heap,
		cpuprofile,
		scenarios,
		warmups: warmups ?? 1,
		reps: reps ?? (quick ? 1 : 5),
		durationMs: Math.round((durationSec ?? (quick ? 10 : 20)) * 1000),
		liveness,
		outDir: join(outRoot, `run-${stamp}`),
		noPin,
		breakFakeModel,
	};
	if (compare !== undefined) options.compare = compare;
	if (saveBaseline !== undefined) {
		const base = join(repoRoot, BASELINES_DIR, saveBaseline);
		const existing = [`${base}.json`, `${base}.md`].find((path) => existsSync(path));
		if (!overwriteBaseline && existing !== undefined) {
			throw new UsageError(`baseline already exists: ${existing} (pass --overwrite-baseline)`);
		}
		options.saveBaseline = saveBaseline;
		if (overwriteBaseline) options.overwriteBaseline = true;
	}
	if (chromiumPath !== undefined) options.chromiumPath = chromiumPath;
	return { options, help, outRoot };
}
