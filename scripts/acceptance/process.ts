/**
 * process — bounded subprocess, polling, HTTP, and Git-environment helpers
 * shared by the acceptance walks. Each walk binds its own default subprocess
 * deadline with {@link boundedCommand}; every wait is hard-bounded so a stuck
 * child or handler can never hang a walk past its phase deadline.
 */
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";

import { scriptEnv } from "./harness";

const POLL_TIMEOUT_MS = 120_000;
const DEFAULT_TIMEOUT_MS = 120_000;

export interface CommandResult {
	code: number;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

export interface CommandOptions {
	cwd?: string;
	env?: Record<string, string>;
	timeoutMs?: number;
}

async function runCommand(
	cmd: readonly string[],
	opts: CommandOptions = {},
): Promise<CommandResult> {
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const proc = Bun.spawn([...cmd], {
		cwd: opts.cwd,
		env: opts.env ?? scriptEnv(),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	let timedOut = false;
	const termTimer = setTimeout(() => {
		timedOut = true;
		proc.kill("SIGTERM");
		setTimeout(() => proc.kill("SIGKILL"), 1_000);
	}, timeoutMs);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	clearTimeout(termTimer);
	return { code: exitCode ?? -1, stdout, stderr, timedOut };
}

/** Bind a walk's own default subprocess deadline (bwrap 120 s, minikube 180 s). */
export function boundedCommand(defaultTimeoutMs: number) {
	return (cmd: readonly string[], opts: CommandOptions = {}): Promise<CommandResult> =>
		runCommand(cmd, { ...opts, timeoutMs: opts.timeoutMs ?? defaultTimeoutMs });
}

export async function waitFor<T>(
	what: string,
	probe: () => T | null | Promise<T | null>,
	opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
	const timeoutMs = opts.timeoutMs ?? POLL_TIMEOUT_MS;
	const intervalMs = opts.intervalMs ?? 250;
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await probe();
		if (value !== null) return value;
		if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, intervalMs);
		await promise;
	}
}

/** Absolute, executable, realpath-resolved tool path (or null). */
export function resolveTool(name: string): string | null {
	const found = Bun.which(name);
	if (found === null) return null;
	try {
		const real = realpathSync(found);
		return existsSync(real) ? real : null;
	} catch {
		return null;
	}
}

export interface JsonResponse {
	status: number;
	body: unknown;
}

/**
 * One bounded JSON request. The deadline is hard: a handler that accepts a
 * request and never answers must fail the caller's current phase instead of
 * hanging the walk — and with it the polling deadline that called into it.
 */
export async function fetchJson(
	url: string,
	init: { method?: string; body?: unknown } = {},
	timeoutMs: number,
): Promise<JsonResponse> {
	const res = await fetch(url, {
		method: init.method ?? "GET",
		headers: init.body !== undefined ? { "content-type": "application/json" } : undefined,
		body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
		signal: AbortSignal.timeout(timeoutMs),
	});
	const text = await res.text();
	let body: unknown = null;
	if (text !== "") {
		try {
			body = JSON.parse(text);
		} catch {
			body = text;
		}
	}
	return { status: res.status, body };
}

/**
 * Carry the operator's Git identity into a walk's isolated Git environment.
 *
 * The walks pin HOME/GIT_CONFIG_GLOBAL, so the only honest identity is the one
 * the operator already configured: the global-config files that actually define
 * `user.name`/`user.email` are copied VERBATIM into `targetPath` (never
 * rewritten through `git config`, never invented), and a host missing either
 * value returns null so the caller can block as a prerequisite.
 */
export async function carryHostGitIdentity(
	gitBin: string,
	targetPath: string,
): Promise<string | null> {
	const result = await runCommand(
		[gitBin, "config", "--global", "--includes", "--show-origin", "--list"],
		{ timeoutMs: 30_000 },
	);
	if (result.code !== 0) return null;
	const origins = new Set<string>();
	let name = "";
	let email = "";
	for (const line of result.stdout.split("\n")) {
		const tab = line.indexOf("\t");
		if (tab < 0) continue;
		const origin = line.slice(0, tab);
		const entry = line.slice(tab + 1);
		const eq = entry.indexOf("=");
		if (!origin.startsWith("file:") || eq < 0) continue;
		const key = entry.slice(0, eq);
		if (key !== "user.name" && key !== "user.email") continue;
		if (key === "user.name") name = entry.slice(eq + 1);
		else email = entry.slice(eq + 1);
		origins.add(origin.slice("file:".length));
	}
	if (name === "" || email === "" || origins.size === 0) return null;
	const contents: string[] = [];
	for (const path of origins) {
		try {
			contents.push(readFileSync(path, "utf8"));
		} catch {
			return null;
		}
	}
	writeFileSync(targetPath, contents.join("\n"));
	return `${name} <${email}> (from ${[...origins].join(", ")})`;
}
