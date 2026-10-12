import type { SettingsModel } from "#lib/wire/protocol";
import type { FleetDebug } from "../../web/fleet-ui/fleet-debug";
import type { FeatureSizeManifest } from "../../web/features/sizes";
import {
	entriesFor,
	health,
	rawTranscript,
	sessionSummaries,
	statsFor,
	storedSessionDetail,
	storedSessions,
	storedWorkspaces,
	subagentsFor,
	syncResult,
	transcriptPage,
} from "./tx";
import { FIXTURE_NOW } from "./session";
import { rosterFsBrowse } from "./roster-routes";
import { answerCommand, eventsResponse } from "./command-bus";

/**
 * Fixture HTTP routes. Components fetch fleet endpoints at runtime (store/fleet-api.ts,
 * store/settings.ts, store/transport.ts, store/auth.ts); the design server
 * answers them from here, before its 404 stub. Add a route by appending to
 * `fixtureRoutes`:
 *
 *   { method: "GET", path: "/ctl/things/:id", respond: ({ params }) => thing(params.id) }
 *
 * Path patterns: `:name` matches one segment, `*name` matches one or more
 * (a session file path such as `proj/x.jsonl`). Values are URL-decoded.
 * `respond` returns any JSON value (200) or a Response for other statuses.
 */
export interface RouteContext {
	params: Record<string, string>;
	query: URLSearchParams;
	/** Parsed JSON request body, or undefined when absent/not JSON. */
	body: unknown;
}

export interface FixtureRoute {
	method: "GET" | "POST";
	path: string;
	respond: (ctx: RouteContext) => unknown;
}

const unavailable = (message: string): Response =>
	Response.json({ error: { code: "unavailable", message } }, { status: 404 });

const settingsModel: SettingsModel = {
	revision: 3,
	target: "future-sessions",
	tabs: [
		{
			id: "general",
			label: "General",
			groups: [
				{
					name: "Display",
					items: [
						{
							path: "display.showThinking",
							label: "Show thinking",
							description: "Render model reasoning blocks in the transcript.",
							type: "boolean",
							value: true,
							changed: false,
						},
						{
							path: "display.toolCards",
							label: "Tool cards",
							description: "How tool calls are laid out in the chat.",
							type: "enum",
							value: "expanded",
							values: ["expanded", "collapsed", "consolidated"],
							changed: true,
						},
					],
				},
				{
					name: "Identity",
					items: [
						{
							path: "identity.displayName",
							label: "Display name",
							description: "Shown beside your messages.",
							type: "text",
							value: "joshua",
							changed: true,
						},
					],
				},
			],
		},
	],
};

const fleetDebug: FleetDebug = {
	fleet: {
		port: 4722,
		startedAt: FIXTURE_NOW - 2 * 3_600_000,
		uptimeSec: 7_200,
		statePath: "/home/joshua/.omp/fleet/state.json",
		configPath: "/home/joshua/.omp/fleet/config.json",
	},
	sessions: [
		{
			daemonId: "d-1",
			name: "omp-web",
			status: "ready",
			mode: "spawned",
			pid: 48_211,
			readyAt: FIXTURE_NOW - 3_000_000,
			registeredAt: FIXTURE_NOW - 3_100_000,
			uptimeSec: 3_000,
			pair: { enrolled: true, paired: true, authorizedGeneration: 3 },
		},
	],
	log: [
		{
			ts: FIXTURE_NOW - 60_000,
			level: "info",
			source: "supervisor",
			message: "daemon d-1 ready",
			daemonId: "d-1",
		},
		{
			ts: FIXTURE_NOW - 30_000,
			level: "warn",
			source: "server",
			message: "reconnecting",
			daemonId: "d-1",
		},
	],
};

/** Fixture build sizes for Settings > Features. Mirrors the production manifest shape. */
const featureSizes: FeatureSizeManifest = {
	version: 1,
	chunks: {
		"assets/index-fixture.js": { bytes: 512000, gzip: 160000 },
		"assets/index-fixture.css": { bytes: 98000, gzip: 17000 },
		"assets/analysis-fixture.js": { bytes: 88000, gzip: 26000 },
		"assets/shared-fixture.js": { bytes: 42000, gzip: 13000 },
		"assets/goals-fixture.js": { bytes: 61000, gzip: 18000 },
		"assets/review-fixture.js": { bytes: 120000, gzip: 34000 },
		"assets/integrations-fixture.js": { bytes: 30000, gzip: 9000 },
		"assets/btw-fixture.js": { bytes: 12000, gzip: 4000 },
		"assets/advisor-fixture.js": { bytes: 22000, gzip: 7000 },
		"assets/debug-fixture.js": { bytes: 18000, gzip: 6000 },
	},
	core: ["assets/index-fixture.js", "assets/index-fixture.css"],
	features: {
		analysis: ["assets/analysis-fixture.js", "assets/shared-fixture.js"],
		goals: ["assets/goals-fixture.js", "assets/shared-fixture.js"],
		review: ["assets/review-fixture.js"],
		integrations: ["assets/integrations-fixture.js"],
		btw: ["assets/btw-fixture.js"],
		advisor: ["assets/advisor-fixture.js"],
		debug: ["assets/debug-fixture.js"],
	},
};

/** Set `available = false` to answer /feature-sizes.json with 404 (a dev build). */
export const featureSizesFixture = { available: true };

export const fixtureRoutes: FixtureRoute[] = [
	// --- store/fleet-api.ts: /ctl/stats ---
	{ method: "GET", path: "/ctl/stats/health", respond: () => health },
	{
		method: "GET",
		path: "/ctl/stats/sessions",
		respond: ({ query }) => {
			const q = (query.get("q") ?? "").toLowerCase();
			const sessions = sessionSummaries.filter(
				(s) => q === "" || `${s.title ?? ""} ${s.folder} ${s.file}`.toLowerCase().includes(q),
			);
			return { sessions, total: sessions.length, truncated: false };
		},
	},
	{
		method: "GET",
		path: "/ctl/stats/sessions/*file/stats",
		respond: ({ params }) => statsFor(params.file ?? "") ?? unavailable("session file unreadable"),
	},
	{
		method: "GET",
		path: "/ctl/stats/sessions/*file/transcript",
		respond: ({ params, query }) => {
			const file = params.file ?? "";
			if (statsFor(file) === null) return unavailable("session file unreadable");
			return transcriptPage(
				Number(query.get("offset") ?? 0),
				Number(query.get("limit") ?? 200),
				entriesFor(file),
			);
		},
	},
	{
		method: "GET",
		path: "/ctl/stats/sessions/*file/subagents",
		respond: ({ params }) => {
			const subagents = subagentsFor(params.file ?? "");
			return subagents === null ? unavailable("session file unreadable") : { subagents };
		},
	},
	{ method: "POST", path: "/ctl/stats/sync", respond: () => syncResult },

	// --- store/fleet-api.ts: /ctl/stored (fleet log store) ---
	{
		method: "GET",
		path: "/ctl/stored/workspaces",
		respond: () => ({ workspaces: storedWorkspaces }),
	},
	{
		method: "GET",
		path: "/ctl/stored/sessions",
		respond: ({ query }) => {
			const workspaceId = query.get("workspaceId");
			return {
				sessions: storedSessions.filter(
					(s) => workspaceId === null || s.workspaceId === workspaceId,
				),
			};
		},
	},
	{
		method: "GET",
		path: "/ctl/stored/sessions/:workspaceId/:sessionId",
		respond: ({ params }) =>
			storedSessionDetail(params.workspaceId ?? "", params.sessionId ?? "") ??
			unavailable("stored session not found"),
	},
	{
		method: "GET",
		path: "/ctl/stored/sessions/:workspaceId/:sessionId/transcript",
		respond: ({ params, query }) => {
			const detail = storedSessionDetail(params.workspaceId ?? "", params.sessionId ?? "");
			if (detail === null) return unavailable("stored session not found");
			const file = query.get("file") ?? detail.mainRelpath ?? "";
			const stored = detail.files.find((f) => f.relpath === file);
			if (stored === undefined) return unavailable("stored file not found");
			if (stored.status === "missing") return unavailable("stored file is missing");
			const entries = entriesFor(file);
			if (query.get("format") === "raw") {
				return new Response(rawTranscript(entries), {
					headers: { "content-type": "application/x-ndjson" },
				});
			}
			return transcriptPage(
				Number(query.get("offset") ?? 0),
				Number(query.get("limit") ?? 200),
				entries,
			);
		},
	},
	{
		method: "POST",
		path: "/ctl/stored/workspaces/:workspaceId/resume",
		respond: ({ params, body }) => ({
			daemonId: "d-resumed",
			workspaceId: params.workspaceId,
			sessionId: (body as { sessionId?: string } | undefined)?.sessionId ?? null,
		}),
	},

	// --- store/*: fleet control plane ---
	{ method: "GET", path: "/ctl/settings", respond: () => settingsModel },
	{ method: "GET", path: "/ctl/debug", respond: () => fleetDebug },
	{
		method: "GET",
		path: "/ctl/templates",
		respond: () => ["default", "review-agent", "docs-writer"],
	},
	{
		method: "GET",
		path: "/ctl/sessions/:daemonId/stderr",
		respond: ({ params }) => ({
			text: `[${params.daemonId}] warn: provider rate limit near, backing off 2s\n[${params.daemonId}] info: resumed\n`,
		}),
	},
	{
		method: "GET",
		path: "/auth/session",
		respond: () => ({ csrfToken: "design-system-csrf", expiresAt: FIXTURE_NOW + 8 * 3_600_000 }),
	},
	{
		method: "GET",
		path: "/ctl/fs/browse",
		respond: ({ query }) => rosterFsBrowse(query.get("path")),
	},
	{
		method: "POST",
		path: "/command",
		respond: ({ body }) =>
			answerCommand(body) ?? unavailable("command not answered by the design server"),
	},
	{
		method: "GET",
		path: "/events",
		respond: () => eventsResponse(),
	},
	{
		method: "GET",
		path: "/feature-sizes.json",
		respond: () =>
			featureSizesFixture.available ? featureSizes : unavailable("No feature sizes in this build."),
	},
];

function compile(path: string): { regex: RegExp; names: string[] } {
	const names: string[] = [];
	const source = path
		.split("/")
		.map((segment) => {
			if (segment.startsWith(":")) {
				names.push(segment.slice(1));
				return "([^/]+)";
			}
			if (segment.startsWith("*")) {
				names.push(segment.slice(1));
				return "(.+)";
			}
			return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		})
		.join("/");
	return { regex: new RegExp(`^${source}$`), names };
}

const compiled = fixtureRoutes.map((route) => ({ route, ...compile(route.path) }));

/** Answer `req` from fixtureRoutes, or return null when no route matches. */
export async function handleFixtureRoute(req: Request): Promise<Response | null> {
	const url = new URL(req.url);
	for (const { route, regex, names } of compiled) {
		if (route.method !== req.method) continue;
		const match = regex.exec(url.pathname);
		if (!match) continue;
		const params: Record<string, string> = {};
		names.forEach((name, i) => {
			params[name] = (match[i + 1] ?? "").split("/").map(decodeURIComponent).join("/");
		});
		const body: unknown =
			req.method === "POST" ? await req.json().catch(() => undefined) : undefined;
		const result = route.respond({ params, query: url.searchParams, body });
		return result instanceof Response ? result : Response.json(result);
	}
	return null;
}
