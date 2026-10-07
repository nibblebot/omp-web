import { evaluateLoopCondition } from "@oh-my-pi/pi-coding-agent/modes/loop-condition";
import {
	consumeLoopLimitIteration,
	createLoopLimitRuntime,
	isLoopLimitExhausted,
	parseLoopArgs,
} from "@oh-my-pi/pi-coding-agent/modes/loop-limit";
import { cfgLoopConditionTimeoutMs } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { RpcGoalController } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-goal";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { LoopConditionConfig, LoopLimitRuntime } from "@oh-my-pi/pi-tui/status-line/loop";
import type { SessionEntry } from "./session-entry";

export interface LoopSnapshot {
	status: "inactive" | "running" | "paused" | "stopped";
	iteration: number;
	prompt?: string;
	limit?: LoopLimitRuntime;
	condition?: LoopConditionConfig;
	nextRunAt?: number;
	stopReason?: string;
}

export interface AutonomyAdapter {
	goal: RpcGoalController;
	ready: Promise<void>;
	snapshot(): LoopSnapshot;
	start(input: { argsText: string; prompt?: string; consent?: boolean }): LoopSnapshot;
	pause(): LoopSnapshot;
	cancel(): LoopSnapshot;
	resume(input: { consent?: boolean }): LoopSnapshot;
	stopForHostAbort(): void;
	beginSessionChange(): Promise<void>;
	endSessionChange(options?: { detachedRun?: boolean }): Promise<void>;
	dispose(): void;
	capabilities: { boundedLoop: boolean; atomicPauseAll: boolean; pauseAllReason: string };
}

const adapters = new WeakMap<SessionEntry, AutonomyAdapter>();

/** One daemon owner per entry; browser reconnects read it, never create another scheduler. */
export function getAutonomyAdapter(entry: SessionEntry) {
	let adapter = adapters.get(entry);
	if (!adapter) {
		adapter = createAutonomyAdapter(entry);
		adapters.set(entry, adapter);
	}
	return adapter;
}

/** Extracted TUI loop gates + SDK's headless goal controller. No import-time effects. */
export function createAutonomyAdapter(entry: SessionEntry): AutonomyAdapter {
	const session = entry.session;
	const goal = new RpcGoalController(session);
	let loop: LoopSnapshot = { status: "inactive", iteration: 0 };
	let generation = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let conditionAbort: AbortController | undefined;
	let disposed = false;
	let transcriptId = session.sessionManager.getSessionId();
	const recovered = [...session.sessionManager.getBranch()]
		.reverse()
		.find((record) => record.type === "custom" && record.customType === "web-autonomy-loop");
	if (recovered?.type === "custom") {
		const data = recovered.data as Partial<LoopSnapshot> | undefined;
		if (
			data &&
			(data.status === "running" || data.status === "paused") &&
			typeof data.iteration === "number" &&
			typeof data.prompt === "string"
		) {
			loop = {
				...data,
				status: "paused",
				iteration: data.iteration,
				nextRunAt: undefined,
				stopReason: "Daemon restarted; explicit resume required",
			};
		}
	}
	const ready = goal.reconcile();
	function snapshot(): LoopSnapshot {
		return {
			...loop,
			limit: loop.limit ? { ...loop.limit } : undefined,
			condition: loop.condition ? { ...loop.condition } : undefined,
		};
	}
	function publish() {
		session.sessionManager.appendCustomEntry("web-autonomy-loop", snapshot());
	}
	function cancelPending() {
		generation++;
		clearTimeout(timer);
		timer = undefined;
		conditionAbort?.abort();
		conditionAbort = undefined;
		loop.nextRunAt = undefined;
	}
	function stop(reason: string, status: "paused" | "stopped" = "stopped") {
		cancelPending();
		loop.status = status;
		loop.stopReason = reason;
		publish();
		return snapshot();
	}
	function blocked() {
		return (
			session.isStreaming ||
			session.isCompacting ||
			session.hasPostPromptWork ||
			session.hasAdmittedSubmission ||
			session.queuedMessageCount > 0 ||
			session.isSessionTransitioning
		);
	}
	function admissible() {
		return (
			!disposed &&
			!session.isDisposed &&
			loop.status === "running" &&
			transcriptId === session.sessionManager.getSessionId() &&
			!session.getPlanModeState()?.enabled &&
			!session.getVibeModeState()?.enabled &&
			!session.getGoalModeState()?.enabled
		);
	}
	function schedule() {
		if (!admissible() || timer) return;
		loop.nextRunAt = Date.now() + 800;
		const ticket = generation;
		timer = setTimeout(() => {
			timer = undefined;
			loop.nextRunAt = undefined;
			void run(ticket).catch((error) =>
				stop(error instanceof Error ? error.message : "Loop submission failed"),
			);
		}, 800);
	}
	async function run(ticket: number) {
		if (ticket !== generation || !admissible()) return;
		if (isLoopLimitExhausted(loop.limit)) {
			stop("Loop limit reached");
			return;
		}
		if (blocked()) {
			schedule();
			return;
		}
		// The TUI runs the first iteration unconditionally; conditions gate continuations.
		if (loop.iteration > 0 && loop.condition) {
			const controller = new AbortController();
			conditionAbort = controller;
			const verdict = await evaluateLoopCondition(loop.condition, {
				cwd: entry.cwd,
				timeoutMs: cfgLoopConditionTimeoutMs.get(session.settings),
				signal: controller.signal,
				sessionId: transcriptId,
			});
			if (conditionAbort === controller) conditionAbort = undefined;
			if (ticket !== generation || !admissible()) return;
			if (verdict.kind !== "continue") {
				if (verdict.kind !== "aborted") stop(verdict.message);
				return;
			}
		}
		if (ticket !== generation || !admissible()) return;
		if (blocked()) {
			schedule();
			return;
		}
		if (!consumeLoopLimitIteration(loop.limit)) {
			stop("Loop limit reached");
			return;
		}
		loop.iteration++;
		publish();
		// Admission is synchronous in the real SDK; only its terminal end arms the next turn.
		const admitted = await session.promptCustomMessage({
			customType: "loop-continuation",
			content: loop.prompt!,
			display: true,
		});
		if (!admitted && ticket === generation) stop("Loop submission was not admitted", "paused");
	}
	function observe(event: AgentSessionEvent) {
		goal.observe(event);
		if (
			event.type !== "agent_end" ||
			event.isTerminal === false ||
			event.yielded ||
			event.awaitingAsyncWork
		)
			return;
		const failed = event.messages.some(
			(message) =>
				message.role === "assistant" &&
				(message.stopReason === "aborted" || message.stopReason === "error"),
		);
		if (failed && loop.status === "running") stop("Main interrupted or failed", "paused");
		else schedule();
	}
	const unsubscribe = session.subscribe(observe);
	return {
		goal,
		ready,
		snapshot,
		start(input: { argsText: string; prompt?: string; consent?: boolean }) {
			if (input.consent !== true) throw new Error("Explicit loop execution consent is required");
			const parsed = parseLoopArgs(input.argsText);
			if (typeof parsed === "string") throw new Error(parsed);
			if (!parsed.limit && !parsed.condition)
				throw new Error("A loop count, duration, until or while rule is required");
			if (loop.status === "running" || loop.status === "paused")
				throw new Error("Cancel the current loop before starting another");
			if (
				session.getPlanModeState()?.enabled ||
				session.getVibeModeState()?.enabled ||
				session.getGoalModeState()?.enabled
			)
				throw new Error("Exit plan, Vibe and goal mode before starting a loop");
			const prompt = (parsed.prompt ?? input.prompt)?.trim();
			if (!prompt) throw new Error("Loop prompt is required");
			cancelPending();
			transcriptId = session.sessionManager.getSessionId();
			loop = {
				status: "running",
				iteration: 0,
				prompt,
				limit: createLoopLimitRuntime(parsed.limit),
				condition: parsed.condition,
			};
			publish();
			schedule();
			return snapshot();
		},
		pause: () => stop("Loop paused; running Main turn is unaffected", "paused"),
		cancel: () => stop("Loop canceled; running Main turn is unaffected"),
		resume(input: { consent?: boolean }) {
			if (input.consent !== true) throw new Error("Explicit loop resume consent is required");
			if (loop.status !== "paused") throw new Error("No paused loop to resume");
			if (transcriptId !== session.sessionManager.getSessionId())
				throw new Error("Loop belongs to another session");
			loop.status = "running";
			loop.stopReason = undefined;
			publish();
			schedule();
			return snapshot();
		},
		stopForHostAbort() {
			goal.stopForHostAbort();
			if (loop.status === "running") stop("Host interrupted Main", "paused");
		},
		async beginSessionChange() {
			if (loop.status === "running") stop("Session changing", "paused");
			await goal.beginSessionChange();
		},
		endSessionChange: (options?: { detachedRun?: boolean }) => goal.endSessionChange(options),
		dispose() {
			disposed = true;
			cancelPending();
			goal.stopForHostAbort();
			unsubscribe();
			adapters.delete(entry);
		},
		capabilities: {
			boundedLoop: true,
			atomicPauseAll: false,
			pauseAllReason:
				"SDK exposes no atomic safe pause spanning Main, workers, advisor and pending asks",
		},
	};
}
