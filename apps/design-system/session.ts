import { parseServerMessage } from "#lib/wire/browser-socket";
import type { ClientCommand, ServerFrame, WebMethodName } from "#lib/wire/protocol";
import { connect, initAuth, resetBrowserSocket } from "../web/state";
import { checkSession } from "../web/store/auth";
import {
	acknowledgeCommand,
	refuseCommand,
	resendUnsettled,
	setConnected,
	setUplink,
	settleCallResult,
} from "../web/store/transport";
import {
	type Connection,
	connectLink,
	type DialOutcome,
	type Fleet,
	installFakeSocket,
	resetFleet,
	setDialOutcome,
} from "./fake-socket";
import { answerBusCommand, primingFrames } from "./fixtures/command-bus";
import { handleFixtureRoute } from "./fixtures/routes";

/**
 * Fake session process for stories. Components reach the session process through the browser
 * socket (`{"cmd":...}` messages); `call()` answers arrive as `call_result`
 * frames on it, and plain commands (list_sessions, list_project_branches, ...)
 * settle store waiters from their frames. Stories have no server, so the fake
 * edge (fake-socket.ts) runs in the page: the real transport and store code
 * run unchanged, only the answers come from story handlers. The App screen
 * and the demo dial it like a browser (`/ws`, replaced at boot); a story that
 * installs handlers gets a bare link instead (no priming, so its seeded store
 * stays as seeded) that carries commands out and acks/answers back, and
 * `resetSession` closes it. Anything without a handler falls through to the
 * App fleet's own commands (fixtures/command-bus.ts), else a nack 404.
 * Control-plane fetches are answered in the page too: a story's own route
 * (`answerRoutes`) first, then fixtures/routes.ts, then a 404 for any other
 * `/ctl` or `/auth` path, so the dev server and the static demo build (served
 * from any path, e.g. GitHub Pages) behave the same.
 *
 * `applySeeds` calls `resetSession()` before every story/variant seed, so
 * handlers, the socket and the connected flag never leak from one story into
 * the next.
 */
export type CallHandler = (args: unknown[]) => unknown;
export type CallHandlers = Partial<Record<WebMethodName, CallHandler>>;
export type CommandHandler = (cmd: ClientCommand) => void;
export type CommandHandlers = Partial<Record<ClientCommand["type"], CommandHandler>>;
/** A Response is sent as is; any other value is sent as a 200 JSON body. A throw answers 500 `{error}`. */
export type RouteHandler = () => unknown;
/** Keyed by `"<METHOD> <pathname>"`, e.g. `"GET /ctl/usage"`. */
export type RouteHandlers = Record<string, RouteHandler>;
export type { DialOutcome };

const ANSWER_DELAY_MS = 120;
/** Control-plane paths no fixture answers get this 404, never the page's host (there is no fleet). */
const NO_FLEET_PATH = /^\/(ctl|auth)(\/|$)/;
const NO_FLEET = { error: "design system: no fleet behind this server" };
let calls: CallHandlers = {};
let commands: CommandHandlers = {};
let routes: RouteHandlers = {};
/** The stories' command channel (see ensureStoryLink), or null. */
let storyLink: Connection | null = null;
/** Teardown of what a story set up (the auth listener of `dialClient`). */
const cleanups: Array<() => void> = [];
/** Bumped by every reset, so async seed work of a previous story drops out. */
let generation = 0;

/** Forget every handler, close the socket and mark the transport disconnected (the pristine state). */
export function resetSession(): void {
	generation++;
	calls = {};
	commands = {};
	routes = {};
	for (const cleanup of cleanups.splice(0)) cleanup();
	storyLink?.dispose();
	storyLink = null;
	resetBrowserSocket();
	resetFleet();
	setConnected(false);
}

/** Route one message of the bare link to the store, as the client's frame mux does for the three answers stories need. */
function routeStoryMessage(text: string): void {
	const message = parseServerMessage(text);
	if (message === null) return;
	if (message.kind === "ack") acknowledgeCommand(message.id);
	else if (message.kind === "nack") refuseCommand(message.id, message.status, message.error);
	else if (message.kind === "frame" && message.frame.type === "call_result") {
		settleCallResult(message.frame);
	}
}

/**
 * Give a story with handlers its command channel: a bare link to the fake
 * edge, bound as the uplink. A client that dials for real (the App) replaces
 * it with its own socket.
 */
function ensureStoryLink(): void {
	setConnected(true);
	if (storyLink !== null) return;
	const conn = connectLink(
		{ deliver: routeStoryMessage, close: () => undefined },
		{ prime: false },
	);
	storyLink = conn;
	setUplink({ send: (text) => conn.receive(text) });
	resendUnsettled();
}

/** Mark the transport connected and answer these `call()` methods; later calls replace the set. */
export function answerCalls(next: CallHandlers): void {
	calls = next;
	ensureStoryLink();
}

/** Answer these `call()` methods in addition to the handlers already installed (a later one for the same method wins). */
export function addCalls(next: CallHandlers): void {
	calls = { ...calls, ...next };
	ensureStoryLink();
}

/** Answer these plain command types (run after a short delay, like a frame arriving). */
export function answerCommands(next: CommandHandlers): void {
	commands = next;
	ensureStoryLink();
}

/** Answer these control-plane fetches ahead of the fixture routes (fixtures/routes.ts). */
export function answerRoutes(next: RouteHandlers): void {
	routes = next;
}

/**
 * Dial the fake edge with the real client (`connect()`) and have it end as
 * `outcome` says: a refused dial, or a typed close such as 4401 or 4426. The
 * client's own teardown, reconnect and sign-in paths run; nothing is poked into
 * the store. Auth state is module-global and a 4401 leaves it signed out, so
 * the session is probed first (the fixture route says signed in) to let the
 * next 4401 transition again.
 */
export function dialClient(outcome: DialOutcome): void {
	setDialOutcome(outcome);
	cleanups.push(initAuth());
	const mine = generation;
	void checkSession()
		.catch(() => undefined)
		.then(() => {
			if (mine === generation) connect();
		});
}

/** Wait as long as an answer takes to arrive: page code never sees a fetch settle within the same tick. */
function answerDelay(): Promise<void> {
	const delay = Promise.withResolvers<void>();
	setTimeout(delay.resolve, ANSWER_DELAY_MS);
	return delay.promise;
}

async function answerRoute(handler: RouteHandler): Promise<Response> {
	await answerDelay();
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

function answerCall(
	cmd: Extract<ClientCommand, { type: "call" }>,
	handler: CallHandler,
	answer: (frame: ServerFrame) => void,
): void {
	setTimeout(async () => {
		try {
			const data = await handler(cmd.args ?? []);
			answer({ type: "call_result", id: cmd.id, ok: true, data });
		} catch (err) {
			const error = err instanceof Error ? err.message : String(err);
			answer({ type: "call_result", id: cmd.id, ok: false, error });
		}
	}, ANSWER_DELAY_MS);
}

/** What the fake edge serves: the App fleet's priming, story handlers first, then the fleet's own commands. */
const fleet: Fleet = {
	priming: primingFrames,
	dispatch(cmd, answer) {
		if (cmd.type === "call") {
			const handler = calls[cmd.method];
			if (handler !== undefined) {
				answerCall(cmd, handler, answer);
				return null;
			}
			// The shared job poll asks whenever a workspace is attached: a session a story gave no job
			// fixture has no async job manager, which is the answer `getJobTree` gives then.
			if (cmd.method === "getJobTree") {
				answerCall(cmd, () => null, answer);
				return null;
			}
			// The composer's cache indicator asks on attach; a session a story gave no cache fixture has nothing to report.
			if (cmd.method === "getPromptCacheStatus") {
				answerCall(cmd, () => ({ status: null }), answer);
				return null;
			}
			// A bash card's Visualize asks on open; a story with no shell-viz fixture has no trace to show.
			if (cmd.method === "getShellVisualization") {
				answerCall(cmd, () => ({ available: false, reason: "no_trace" }), answer);
				return null;
			}
		} else {
			const handler = commands[cmd.type];
			if (handler !== undefined) {
				setTimeout(() => handler(cmd), ANSWER_DELAY_MS);
				return null;
			}
		}
		if (answerBusCommand(cmd, answer)) return null;
		return { status: 404, error: "command not answered by the design server" };
	},
};

/** Install the in-page fetch hook (story routes, fixture routes, the no-fleet 404) and the fake browser socket once, at boot (boot.tsx). */
export function installSession(): void {
	const nativeFetch = window.fetch.bind(window);
	const answering = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url = new URL(input instanceof Request ? input.url : String(input), location.href);
		const method = (
			init?.method ?? (input instanceof Request ? input.method : "GET")
		).toUpperCase();
		const routeHandler = routes[`${method} ${url.pathname}`];
		if (routeHandler) return answerRoute(routeHandler);
		if (url.origin !== location.origin) return nativeFetch(input, init);
		const fixture = await handleFixtureRoute(
			new Request(input instanceof Request ? input.clone() : url, init),
		);
		if (fixture) {
			await answerDelay();
			return fixture;
		}
		if (NO_FLEET_PATH.test(url.pathname)) {
			await answerDelay();
			return Response.json(NO_FLEET, { status: 404 });
		}
		return nativeFetch(input, init);
	};
	Object.defineProperty(window, "fetch", { value: answering, configurable: true, writable: true });
	installFakeSocket(fleet);
}
