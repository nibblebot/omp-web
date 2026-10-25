/**
 * Child-process harness for fleet-callback-pair-timeout.test.ts. Runs under a
 * `bun` started with BUN_CONFIG_HTTP_IDLE_TIMEOUT=1 (Bun reads it at process
 * start), which shrinks the native HTTP client timeout from minutes to ~8 s and
 * makes a default-timeout cut of the session's pair observable in seconds. A
 * real FleetCallback pair dials a real SessionTransportRegistry over loopback
 * WebSocket, is held for holdMs with heartbeats flowing both ways, and the
 * outcome is printed as ONE JSON line on stdout.
 *
 * argv: <holdMs> <heartbeatMs>
 */
import { SessionTransportRegistry } from "../../fleet/session-transport";
import { FleetCallback, type FleetCallbackStatus } from "../fleet-callback";

const WORKSPACE = "ws-pair-timeout";
const GENERATION = 1;
const TOKEN = "b".repeat(64);

const holdMs = Number(process.argv[2]);
const heartbeatMs = Number(process.argv[3]);

const registry = new SessionTransportRegistry();
registry.enrollWorkspace(WORKSPACE, GENERATION, TOKEN);
// The server's own idle timeout is pinned: only the CLIENT side is under test.
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	idleTimeout: 255,
	fetch: async (req, srv) =>
		(await registry.handleFetch(req, srv)) ?? new Response("not found", { status: 404 }),
	websocket: registry.websocket,
});

const connectionIds = new Set<string>();
const errors: string[] = [];
const callback = new FleetCallback(
	{
		url: `http://127.0.0.1:${server.port}`,
		workspaceId: WORKSPACE,
		generation: GENERATION,
		token: TOKEN,
		allowHttp: true,
		heartbeatMs,
	},
	{
		onStatus: (status: FleetCallbackStatus) => {
			if (status.connectionId !== null) connectionIds.add(status.connectionId);
		},
		onError: (error, context) => {
			errors.push(`${context.phase}: ${error.code}: ${error.message}`);
		},
	},
);

try {
	await callback.start();
	const readyConnectionId = callback.status().connectionId;
	await Bun.sleep(holdMs);
	const status = callback.status();
	console.log(
		JSON.stringify({
			readyConnectionId,
			finalConnectionId: status.connectionId,
			connectionIds: [...connectionIds],
			state: status.state,
			readyCount: status.readyCount,
			reconnects: status.reconnects,
			lastError: status.lastError,
			errors,
		}),
	);
} finally {
	callback.stop();
	registry.close();
	server.stop(true);
}
process.exit(0);
