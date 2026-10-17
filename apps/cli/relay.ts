/**
 * `omp-web relay --port <n>`: the standalone collab relay.
 *
 * Serves the collab room protocol (`/r/<roomId>?role=host|guest`) over
 * WebSocket and nothing else. Sessions publish rooms through it when
 * `collab.relayUrl` names this relay (`ws://<host>:<port>`); `omp join` guests
 * dial the same URL from the room link. The relay holds no credentials: rooms
 * are protected by the E2E room key, and the relay sees only ciphertext.
 *
 * Binds loopback by default. Whoever can reach the port can create rooms, so
 * bind a routable address only behind a trusted network or a proxy.
 */

import type { Server } from "bun";
import {
	createRelay,
	type RelayHandle,
	type RelayOptions,
	type RelaySocketData,
} from "./collab-relay";

export interface RelayServerOptions extends RelayOptions {
	/** TCP port; 0 picks an ephemeral one (tests). */
	port: number;
	/** Bind address. Default 127.0.0.1. */
	hostname?: string;
}

export interface RunningRelay {
	server: Server<RelaySocketData>;
	relay: RelayHandle;
	/** The `ws://` URL sessions set as `collab.relayUrl`. */
	url: string;
}

/** Start a relay HTTP/WebSocket server on the given address. */
export function startRelayServer(opts: RelayServerOptions): RunningRelay {
	const { port, hostname = "127.0.0.1", ...relayOptions } = opts;
	const relay = createRelay(relayOptions);
	const server = Bun.serve<RelaySocketData>({
		port,
		hostname,
		fetch(req, srv) {
			const result = relay.handleUpgrade(new URL(req.url), srv, req);
			if (result === null) return new Response("Not found", { status: 404 });
			if (result.handled) return undefined;
			return new Response(result.reason, { status: result.status });
		},
		websocket: {
			open: (ws) => relay.handleOpen(ws),
			message: (ws, raw) => relay.handleMessage(ws, raw),
			close: (ws) => relay.handleClose(ws),
		},
	});
	const host = hostname.includes(":") ? `[${hostname}]` : hostname;
	return { server, relay, url: `ws://${host}:${server.port}` };
}

export interface RelayArgs {
	port: number;
	hostname: string;
	maxGuests?: number;
	maxRooms?: number;
}

export const RELAY_USAGE = `usage: omp-web relay --port <n> [options]

  --port <n>          listen port (required; set the same URL as collab.relayUrl)
  --hostname <addr>   bind address (default 127.0.0.1)
  --max-guests <n>    guests per room (default 64)
  --max-rooms <n>     concurrent rooms (default 256)
`;

function positiveInt(name: string, raw: string | undefined, allowZero: boolean): number | string {
	const value = Number(raw);
	const min = allowZero ? 0 : 1;
	if (raw === undefined || raw === "" || !Number.isInteger(value) || value < min) {
		return `${name} must be an integer >= ${min}`;
	}
	return value;
}

/** Parse `relay` argv (everything after the subcommand). Pure; returns an error message on bad input. */
export function parseRelayArgs(argv: string[]): RelayArgs | { error: string } {
	const values = new Map<string, string>();
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		if (!flag.startsWith("--")) return { error: `unexpected argument: ${flag}` };
		const value = argv[i + 1];
		if (value === undefined || value.startsWith("--")) return { error: `${flag} needs a value` };
		values.set(flag, value);
		i++;
	}
	for (const flag of values.keys()) {
		if (!["--port", "--hostname", "--max-guests", "--max-rooms"].includes(flag)) {
			return { error: `unknown option: ${flag}` };
		}
	}
	const rawPort = values.get("--port");
	if (rawPort === undefined) return { error: "--port is required" };
	const port = positiveInt("--port", rawPort, true);
	if (typeof port === "string") return { error: port };
	if (port > 65535) return { error: "--port must be at most 65535" };
	const args: RelayArgs = { port, hostname: values.get("--hostname") ?? "127.0.0.1" };
	const maxGuests = values.get("--max-guests");
	if (maxGuests !== undefined) {
		const parsed = positiveInt("--max-guests", maxGuests, false);
		if (typeof parsed === "string") return { error: parsed };
		args.maxGuests = parsed;
	}
	const maxRooms = values.get("--max-rooms");
	if (maxRooms !== undefined) {
		const parsed = positiveInt("--max-rooms", maxRooms, false);
		if (typeof parsed === "string") return { error: parsed };
		args.maxRooms = parsed;
	}
	return args;
}

/** CLI entry: run the relay until SIGINT/SIGTERM. Returns the process exit code. */
export async function main(argv: string[]): Promise<number> {
	if (argv[0] === "--help" || argv[0] === "-h") {
		console.log(RELAY_USAGE);
		return 0;
	}
	const parsed = parseRelayArgs(argv);
	if ("error" in parsed) {
		console.error(`omp-web relay: ${parsed.error}\n\n${RELAY_USAGE}`);
		return 1;
	}
	const running = startRelayServer({
		port: parsed.port,
		hostname: parsed.hostname,
		maxGuests: parsed.maxGuests,
		maxRooms: parsed.maxRooms,
	});
	console.log(`omp-web relay listening on ${running.url}`);
	await new Promise<void>((resolve) => {
		process.once("SIGINT", resolve);
		process.once("SIGTERM", resolve);
	});
	running.server.stop(true);
	return 0;
}
