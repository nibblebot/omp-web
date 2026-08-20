/**
 * wireSession regression tests: a queued steer must clear from the queue the
 * moment it is delivered into the conversation (finding: nothing broadcast
 * state on delivery, so state.queuedMessageCount — and the QueueBar chips it
 * refetches — stayed stale until the next unrelated broadcast).
 *
 * The subscribe callback is tested hermetically: a fake session entry with a
 * subscriber tap + a stub broker counting broadcastState calls. The mid-run
 * race the regression is about (queue populated while a turn is streaming,
 * then the loop injects the steer) is simulated exactly: the drain is what
 * dequeues, so the broker is invoked with a session whose queue is already
 * empty — and the assertion is that the delivered steer triggers a broadcast.
 */
import { describe, expect, test } from "bun:test";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { SessionEntry } from "./session-entry";
import { createCollabSession } from "./collab-session";

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

/** A delivered user steer exactly as the SDK emits it (#queueUserMessage). */
function deliveredSteer(): AgentSessionEvent {
	return {
		type: "message_start",
		message: {
			role: "user",
			content: [{ type: "text", text: "hold on" }],
			steering: true,
			attribution: "user",
			timestamp: Date.now(),
		},
	};
}

describe("wireSession queue-staleness regression", () => {
	test("a delivered user steer broadcasts state (queue already drained server-side)", () => {
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

		// The drain runs before the subscribe callback fires (the loop dequeues
		// the steer, then emits message_start): the broker snapshot therefore
		// sees the queue empty — that is exactly the stale-count window. The
		// delivered steer's message_start must still trigger a refresh.
		fire(deliveredSteer());

		expect(calls.length).toBe(1);
		expect(calls[0]).toEqual({ withStats: false });
	});

	test("non-steer user message_start events do not broadcast", () => {
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

		// Hidden system steers carry attribution "agent" — they are not
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
