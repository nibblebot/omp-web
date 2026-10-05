/**
 * SDK displayable queue transitions must resync the existing state snapshot
 * immediately, including dequeue, removal/restoration and follow-up changes.
 * Hidden agent-authored steers remain coalesced away by the SDK.
 */
import { describe, expect, test } from "bun:test";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { SessionEntry } from "../session-entry";
import { createCollabSession } from "../collab-session";

type Listener = (event: AgentSessionEvent) => void;

/** Minimal session stub: only the subscribe surface wireSession touches. */
function fakeSession(): { session: AgentSession; fire: (event: AgentSessionEvent) => void } {
	const listeners: Listener[] = [];
	return {
		session: {
			subscribe: (listener: Listener) => {
				listeners.push(listener);
				return () => {
					const i = listeners.indexOf(listener);
					if (i >= 0) listeners.splice(i, 1);
				};
			},
		} as unknown as AgentSession,
		fire: (event) => {
			for (const l of listeners) l(event);
		},
	};
}

/** Minimal broker stub: counts broadcastState calls (withStats flag included). */
function stubBroker() {
	const calls: { withStats: boolean }[] = [];
	return {
		broker: {
			buildStateSnapshot: () => ({}) as never,
			broadcastState: async (_entry: SessionEntry, withStats = false) => {
				calls.push({ withStats });
			},
			broadcastAvailableCommands: async () => {},
			daemonInfoWithEndpoint: async () => ({}) as never,
			startDaemonPoll: () => {},
			stopDaemonPoll: () => {},
		},
		calls,
	};
}

/** A displayable queue snapshot after delivery or removal. */
function drainedQueue(): AgentSessionEvent {
	return { type: "queue_update", steering: [], followUp: [] };
}

describe("wireSession queue-staleness regression", () => {
	test("a drained queue broadcasts state without waiting for a transcript event", () => {
		const { broker, calls } = stubBroker();
		const collab = createCollabSession({
			config: { idleTimeoutMs: 0 } as never,
			agentDir: "",
			authStorage: {} as never,
			modelRegistry: {} as never,
			settings: {} as never,
			broker,
		});
		const { session, fire } = fakeSession();
		collab.wireSession({
			handle: "s1",
			cwd: "/tmp",
			session,
			eventBus: { on: () => () => {} } as never,
		} as unknown as SessionEntry);

		// Queue mutations notify after changing the SDK queue, so the broker
		// reads the post-delivery count even when no message_start is emitted.
		fire(drainedQueue());

		expect(calls.length).toBe(1);
		expect(calls[0]).toEqual({ withStats: false });
	});

	test("message_start no longer duplicates queue_update state refreshes", () => {
		const { broker, calls } = stubBroker();
		const collab = createCollabSession({
			config: { idleTimeoutMs: 0 } as never,
			agentDir: "",
			authStorage: {} as never,
			modelRegistry: {} as never,
			settings: {} as never,
			broker,
		});
		const { session, fire } = fakeSession();
		collab.wireSession({
			handle: "s1",
			cwd: "/tmp",
			session,
			eventBus: { on: () => () => {} } as never,
		} as unknown as SessionEntry);

		// A normal user turn (Enter while idle / prompt) is not a steer: no
		// steering flag, no broadcast.
		fire({
			type: "message_start",
			message: { role: "user", content: "hello", timestamp: Date.now() },
		});
		fire({
			type: "message_start",
			message: {
				role: "user",
				content: "delivered steer",
				steering: true,
				attribution: "user",
				timestamp: Date.now(),
			},
		});
		expect(calls.length).toBe(0);
	});

	test("agent-authored queued messages (advisor/prewalk) never broadcast", () => {
		const { broker, calls } = stubBroker();
		const collab = createCollabSession({
			config: { idleTimeoutMs: 0 } as never,
			agentDir: "",
			authStorage: {} as never,
			modelRegistry: {} as never,
			settings: {} as never,
			broker,
		});
		const { session, fire } = fakeSession();
		collab.wireSession({
			handle: "s1",
			cwd: "/tmp",
			session,
			eventBus: { on: () => () => {} } as never,
		} as unknown as SessionEntry);

		// Hidden system steers carry attribution "agent"; they are not
		// user-restorable, never surface as chips, and must not broadcast.
		fire({
			type: "message_start",
			message: {
				role: "user",
				content: [{ type: "text", text: "prewalk nudge" }],
				steering: true,
				attribution: "agent",
				timestamp: Date.now(),
			},
		});
		expect(calls.length).toBe(0);
	});
});
