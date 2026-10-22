/**
 * A minimal HTTP CONNECT proxy for tests: it records the authority of every
 * CONNECT request, answers 200, and relays the tunnel in both directions with
 * stream backpressure (`pipe`), so it carries hundreds of MiB without
 * buffering them. It never looks inside the tunnel, so TLS stays end to end.
 * Import ONLY from *.test.ts files.
 */
import { createServer, connect, type Server, type Socket } from "node:net";

export interface ConnectProxy {
	/** `http://127.0.0.1:<port>`, ready for a `proxy` option or HTTP(S)_PROXY. */
	url: string;
	/** Authority (`host:port`) of every CONNECT request, in order. */
	connects: string[];
	stop(): void;
}

const CONNECT_LINE = /^CONNECT ([^ ]+) HTTP\/1\.[01]\r\n/;

/** Listen on an ephemeral loopback port; resolves once the proxy accepts connections. */
export async function startConnectProxy(): Promise<ConnectProxy> {
	const connects: string[] = [];
	const live = new Set<Socket>();
	const server: Server = createServer((client) => {
		live.add(client);
		client.once("close", () => live.delete(client));
		client.on("error", () => client.destroy());
		client.once("data", (head: Buffer) => {
			const request = CONNECT_LINE.exec(head.toString("latin1"));
			if (request === null) {
				client.destroy();
				return;
			}
			const authority = request[1]!;
			connects.push(authority);
			const split = authority.lastIndexOf(":");
			const upstream = connect(Number(authority.slice(split + 1)), authority.slice(0, split));
			live.add(upstream);
			upstream.once("close", () => {
				live.delete(upstream);
				client.destroy();
			});
			client.once("close", () => upstream.destroy());
			upstream.on("error", () => upstream.destroy());
			upstream.once("connect", () => {
				client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
				client.pipe(upstream);
				upstream.pipe(client);
			});
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("proxy has no port");
	return {
		url: `http://127.0.0.1:${address.port}`,
		connects,
		stop() {
			server.close();
			for (const socket of live) socket.destroy();
		},
	};
}
