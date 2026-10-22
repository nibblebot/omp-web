/**
 * Session half of callback-tls-proxy.test.ts, run as its own process so the
 * trust anchor (NODE_EXTRA_CA_CERTS, read by Bun at process start) and the
 * proxy (HTTPS_PROXY, resolved by FleetCallback) come from the environment,
 * exactly as an installed omp-session gets them. One real FleetCallback dials
 * the fleet, sends the volume, and waits for one down command.
 *
 * Environment: VOLUME_URL, VOLUME_WORKSPACE, VOLUME_TOKEN. Reports one JSON
 * object per stdout line: `ready`, `error` (code, message), `sent`, `command`
 * (id), then `final` (status counters) once the command arrived, and exits 0.
 */
import { FleetCallback } from "../../session/fleet-callback";
import { sendVolume } from "./callback-volume.testkit";

function report(event: Record<string, unknown>): void {
	process.stdout.write(`${JSON.stringify(event)}\n`);
}

function required(name: string): string {
	const value = process.env[name];
	if (value === undefined || value === "") throw new Error(`${name} is not set`);
	return value;
}

const command = Promise.withResolvers<string>();
const callback = new FleetCallback(
	{
		url: required("VOLUME_URL"),
		workspaceId: required("VOLUME_WORKSPACE"),
		generation: 1,
		token: required("VOLUME_TOKEN"),
		backoffMinMs: 50,
		backoffMaxMs: 200,
	},
	{
		onEnvelope: (envelope) => {
			if (envelope.kind !== "command") return;
			const payload = envelope.payload as { id?: string };
			report({ event: "command", id: payload.id });
			command.resolve(payload.id ?? "");
		},
		onError: (error) => report({ event: "error", code: error.code, message: error.message }),
	},
);

await callback.start();
report({ event: "ready" });
await sendVolume(callback);
report({ event: "sent" });
await command.promise;
const { reconnects, readyCount, drops, rejected, badMessages } = callback.status();
report({ event: "final", reconnects, readyCount, drops, rejected, badMessages });
callback.stop();
process.exit(0);
