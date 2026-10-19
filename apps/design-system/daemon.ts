import type { ClientCommand, WebMethodName } from "#lib/wire/protocol";
import { setConnected, settleCallResult } from "../web/store/transport";

/**
 * Fake daemon for stories. Components reach the daemon through POST /command:
 * `call()` answers arrive as `call_result` frames on /events, and plain commands
 * (list_sessions, list_project_branches, ...) settle store waiters from their frames.
 * Stories have no /events stream, so this module answers in the page: the real
 * transport and store code run unchanged, only the answers come from story
 * handlers. Anything without a handler falls through to the design server,
 * which serves the App screen's SSE stream and its command bus
 * (fixtures/command-bus.ts), and answers control-plane fetches from
 * fixtures/routes.ts unless a story overrides the route (`answerRoutes`).
 *
 * `applySeeds` calls `resetDaemon()` before every story/variant seed, so
 * handlers and the connected flag never leak from one story into the next.
 */
export type CallHandler = (args: unknown[]) => unknown;
export type CallHandlers = Partial<Record<WebMethodName, CallHandler>>;
export type CommandHandler = (cmd: ClientCommand) => void;
export type CommandHandlers = Partial<Record<ClientCommand["type"], CommandHandler>>;
/** A Response is sent as is; any other value is sent as a 200 JSON body. A throw answers 500 `{error}`. */
export type RouteHandler = () => unknown;
/** Keyed by `"<METHOD> <pathname>"`, e.g. `"GET /ctl/usage"`. */
export type RouteHandlers = Record<string, RouteHandler>;

const ANSWER_DELAY_MS = 120;
/** Retries reuse the command id; answer each id once, like the daemon's dedup window. */
const answeredIds = new Set<string>();
let calls: CallHandlers = {};
let commands: CommandHandlers = {};
let routes: RouteHandlers = {};

/** Forget every handler and mark the transport disconnected (the pristine state). */
export function resetDaemon(): void {
	calls = {};
	commands = {};
	routes = {};
	setConnected(false);
}

/** Mark the transport connected and answer these `call()` methods; later calls replace the set. */
export function answerCalls(next: CallHandlers): void {
	calls = next;
	setConnected(true);
}

/** Answer these plain command types (run after a short delay, like a frame arriving). */
export function answerCommands(next: CommandHandlers): void {
	commands = next;
	setConnected(true);
}

/** Answer these control-plane fetches in the page instead of the design server's fixture routes. */
export function answerRoutes(next: RouteHandlers): void {
	routes = next;
}

async function answerRoute(handler: RouteHandler): Promise<Response> {
	const delay = Promise.withResolvers<void>();
	setTimeout(delay.resolve, ANSWER_DELAY_MS);
	await delay.promise;
	try {
		const data = await handler();
		return data instanceof Response ? data : Response.json(data);
	} catch (err) {
		return Response.json(
			{ error: err instanceof Error ? err.message : String(err) },
			{ status: 500 },
		);
	}
}

function answerCall(cmd: Extract<ClientCommand, { type: "call" }>, handler: CallHandler): void {
	setTimeout(async () => {
		try {
			const data = await handler(cmd.args ?? []);
			settleCallResult({ type: "call_result", id: cmd.id, ok: true, data });
		} catch (err) {
			const error = err instanceof Error ? err.message : String(err);
			settleCallResult({ type: "call_result", id: cmd.id, ok: false, error });
		}
	}, ANSWER_DELAY_MS);
}

/** Install the /command hook once, at boot (boot.tsx). */
export function installDaemon(): void {
	const nativeFetch = window.fetch.bind(window);
	const answering = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const body = init?.body;
		const url = new URL(input instanceof Request ? input.url : String(input), location.href);
		const method = (
			init?.method ?? (input instanceof Request ? input.method : "GET")
		).toUpperCase();
		const routeHandler = routes[`${method} ${url.pathname}`];
		if (routeHandler) return answerRoute(routeHandler);
		if (url.pathname !== "/command" || typeof body !== "string") return nativeFetch(input, init);
		const cmd = JSON.parse(body) as ClientCommand;
		const callHandler = cmd.type === "call" ? calls[cmd.method] : undefined;
		const commandHandler = cmd.type === "call" ? undefined : commands[cmd.type];
		if (callHandler === undefined && commandHandler === undefined) return nativeFetch(input, init);
		if (!answeredIds.has(cmd.id)) {
			answeredIds.add(cmd.id);
			if (cmd.type === "call" && callHandler) answerCall(cmd, callHandler);
			else if (commandHandler) setTimeout(() => commandHandler(cmd), ANSWER_DELAY_MS);
		}
		return new Response(null, { status: 202 });
	};
	Object.defineProperty(window, "fetch", { value: answering, configurable: true, writable: true });
}
