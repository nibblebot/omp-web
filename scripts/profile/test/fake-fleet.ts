import {
	ackMessage,
	BROWSER_SOCKET_PATH,
	nackMessage,
	parseBrowserSocketParams,
	parseClientMessage,
	pingMessage,
	seqFrameMessage,
} from "#lib/wire/browser-socket";

/**
 * A minimal fake fleet edge speaking the browser socket (`GET /ws`, OMP_PROTO 6) for the
 * profile harness tests. It implements exactly what `adapters/ws.ts` documents it expects:
 * the upgrade (`client`, `after`, `proto` query), sequenced frames with a replay ring, one
 * ack/nack per command, and typed closes. It answers nothing on its own except what the
 * options below enable.
 */

export interface PostedCommand {
	type: string;
	id: string;
	method: string;
	args: unknown[];
	workspaceId?: string;
}

export type Frame = Record<string, unknown> & { type: string };

export interface Dial {
	client: string | null;
	after: number | null;
	proto: number | null;
}

export interface FakeFleetOptions {
	/** Refuse a command with this nack instead of an ack. */
	nack?: (command: PostedCommand) => { status: number; error: string } | undefined;
	/** Answer `attach` with attach_result ok plus a priming group, as the edge does. */
	autoAttach?: boolean;
	/** Upgrade, then close at once with this typed close (a dial-time refusal). */
	refuse?: { code: number; reason: string };
}

export class FakeFleet {
	readonly commands: PostedCommand[] = [];
	readonly dials: Dial[] = [];
	/** How many priming groups the fleet had sent when each command arrived. */
	readonly primesAtPost: number[] = [];
	#primes = 0;
	readonly #server: Bun.Server<undefined>;
	readonly #options: FakeFleetOptions;
	#socket: Bun.ServerWebSocket<undefined> | undefined;
	#socketReady = Promise.withResolvers<void>();
	#seq = 0;
	/** Sequenced frames the fleet sent, kept for `after` replay. */
	readonly #ring: Array<{ seq: number; json: string }> = [];
	readonly #commandWaiters: Array<{ n: number; resolve: (c: PostedCommand) => void }> = [];
	readonly #pendingDial: Dial[] = [];

	constructor(options: FakeFleetOptions = {}) {
		this.#options = options;
		this.#server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			// The socket stays open for the whole test.
			idleTimeout: 0,
			fetch: (req, server) => {
				const url = new URL(req.url);
				if (url.pathname !== BROWSER_SOCKET_PATH) return new Response("not found", { status: 404 });
				const params = parseBrowserSocketParams(url.searchParams);
				this.#pendingDial.push({
					client: params.clientId,
					after: params.after,
					proto: params.proto,
				});
				if (server.upgrade(req)) return undefined;
				return new Response("upgrade required", { status: 426 });
			},
			websocket: {
				perMessageDeflate: false,
				open: (ws) => {
					const dial = this.#pendingDial.shift();
					if (dial !== undefined) this.dials.push(dial);
					if (this.#options.refuse !== undefined) {
						ws.close(this.#options.refuse.code, this.#options.refuse.reason);
						return;
					}
					this.#socket = ws;
					ws.send(pingMessage(Date.now()));
					for (const entry of this.#ring) {
						if (dial?.after != null && entry.seq <= dial.after) continue;
						ws.send(seqFrameMessage(entry.seq, entry.json));
					}
					this.#socketReady.resolve();
				},
				message: (ws, data) => {
					const text = typeof data === "string" ? data : data.toString();
					const parsed = parseClientMessage(text, Buffer.byteLength(text));
					if (!parsed.ok) return;
					const command = parsed.command as unknown as PostedCommand;
					this.commands.push(command);
					this.primesAtPost.push(this.#primes);
					const refusal = this.#options.nack?.(command);
					if (refusal !== undefined) {
						ws.send(nackMessage(command.id, refusal.status, refusal.error));
					} else {
						ws.send(ackMessage(command.id));
						if (command.method === "ping") {
							this.push({ type: "call_result", id: command.id, ok: true });
						}
						if (command.type === "attach" && this.#options.autoAttach === true) {
							this.push({ type: "attach_result", id: command.id, ok: true });
							this.prime(false);
						}
					}
					for (const waiter of this.#commandWaiters.splice(0)) {
						if (this.commands.length >= waiter.n) waiter.resolve(this.commands[waiter.n - 1]!);
						else this.#commandWaiters.push(waiter);
					}
				},
				close: (ws) => {
					if (this.#socket === ws) {
						this.#socket = undefined;
						this.#socketReady = Promise.withResolvers<void>();
					}
				},
			},
		});
	}

	get baseUrl(): string {
		return `http://127.0.0.1:${this.#server.port}`;
	}

	/** Highest seq sent so far (0 = none). */
	get lastSeq(): number {
		return this.#seq;
	}

	/** Resolves with the nth (1-based) command received so far or yet to come. */
	command(n: number): Promise<PostedCommand> {
		const have = this.commands[n - 1];
		if (have !== undefined) return Promise.resolve(have);
		const { promise, resolve } = Promise.withResolvers<PostedCommand>();
		this.#commandWaiters.push({ n, resolve });
		return promise;
	}

	/** Resolves once a client socket is attached (a redial lands here too). */
	connected(): Promise<void> {
		return this.#socketReady.promise;
	}

	/** Sequenced frames: ringed for `after` replay and sent to the connected socket. */
	push(...frames: Frame[]): void {
		for (const frame of frames) {
			const entry = { seq: ++this.#seq, json: JSON.stringify(frame) };
			this.#ring.push(entry);
			this.#socket?.send(seqFrameMessage(entry.seq, entry.json));
		}
	}

	/** Send a raw text message as is (for protocol-violation cases). */
	pushRaw(text: string): void {
		this.#socket?.send(text);
	}

	/** The edge's priming group for an attach: attached, state, history, available_commands. */
	prime(isStreaming: boolean): void {
		this.#primes++;
		this.push(
			{ type: "attached", scope: "s1" },
			{ type: "state", state: { isStreaming } },
			{ type: "history", messages: [], final: true },
			{ type: "available_commands", commands: [] },
		);
	}

	/** Close the connected socket with a typed code (4503 slow consumer, 4426 ...). */
	closeSocket(code: number, reason: string): void {
		this.#socket?.close(code, reason);
	}

	async stop(): Promise<void> {
		try {
			this.#socket?.close(1000, "test over");
		} catch {
			// Already closed by the client.
		}
		await this.#server.stop(true);
	}
}
