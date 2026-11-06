import type { Settings } from "@oh-my-pi/pi-coding-agent";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { ComposerPredictionController } from "@oh-my-pi/pi-coding-agent/modes/controllers/composer-prediction-controller";
import { RpcWordPredictor } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import {
	cfgComposerPredictions,
	cfgSpellingAutocomplete,
} from "@oh-my-pi/pi-coding-agent/modes/settings";
import { textPredictionBackend } from "@oh-my-pi/pi-coding-agent/predict/client";
import { wordCompletionQuery } from "@oh-my-pi/pi-tui/prompt/word-completion";
import type { PredictNextMessageReply } from "#lib/wire/protocol";
import type { SessionEntry } from "./session-entry";

/** Mirrors the SDK prediction deadline; the controller aborts its own side turn at this point. */
const PREDICTION_DEADLINE_MS = 15_000;
/** Backstop past the deadline for a call whose controller never settles it (it settles at once on every ordinary outcome). */
const PREDICTION_SETTLE_GRACE_MS = 1_000;

type ControllerOptions = NonNullable<ConstructorParameters<typeof ComposerPredictionController>[1]>;
/** Options of {@link createComposerMethods}; tests inject a metrics sink. */
export interface ComposerMethodsOptions {
	meterProvider?: ControllerOptions["meterProvider"];
}

type ComposerMethod = (entry: SessionEntry, args: unknown[]) => Promise<unknown>;

/**
 * The slice of the SDK controller host the web needs: the session, an empty
 * draft, no focused subagent, and a render hook. The SDK does not export its
 * context type, so the object is built here and cast once at construction.
 */
interface PredictionHost {
	settings: Settings;
	viewSession: AgentSession;
	focusedAgentId: undefined;
	editor: { getText(): string };
	ui: { requestRender(): void };
}

/**
 * The prediction the composer can still report on. Kept from its request until it retires, so the
 * controller's metrics (`omp.composer.prediction.*`) see the shown and accepted calls and resolve the
 * prediction as accepted or ignored when it retires.
 */
interface LivePrediction {
	controller: ComposerPredictionController;
	/** Retires the prediction (the controller records how it resolved) and answers a request still waiting with null. */
	retire(): void;
}

/** Validates the text and UTF-16 cursor args of the word-prediction calls (mirrors the SDK RPC). */
function checkedTextCursor(text: unknown, cursor: unknown): { text: string; cursor: number } {
	if (
		typeof text !== "string" ||
		typeof cursor !== "number" ||
		!Number.isInteger(cursor) ||
		cursor < 0 ||
		cursor > text.length
	) {
		throw new Error("cursor must be an integer UTF-16 offset within text");
	}
	return { text, cursor };
}

/**
 * Composer ghost-text query at a UTF-16 cursor offset, gated like the TUI
 * editor's: only at the end of a line, and only for a prose word. Same rule as
 * the SDK RPC's private `wordQueryAt`, which is not exported.
 */
function wordQueryAt(text: string, cursor: number) {
	if (cursor < text.length && text[cursor] !== "\n") return undefined;
	const lines = text.split("\n");
	let cursorLine = 0;
	let lineStart = 0;
	while (lineStart + lines[cursorLine]!.length < cursor)
		lineStart += lines[cursorLine++]!.length + 1;
	return wordCompletionQuery(lines, cursorLine, cursor - lineStart);
}

/**
 * A view of `session` whose `runEphemeralTurn` reports when it has settled, so the call knows the
 * controller's run is over whatever its outcome. The view reads through to the session (`this` is the
 * session for getters and methods, so private fields work) and is one stable object, which the
 * controller compares by identity when it checks that a prediction is current.
 */
function watchEphemeralTurn(
	session: AgentSession,
	onStart: () => void,
	onSettled: () => void,
): AgentSession {
	const runEphemeralTurn: AgentSession["runEphemeralTurn"] = async (args) => {
		onStart();
		try {
			return await session.runEphemeralTurn(args);
		} finally {
			onSettled();
		}
	};
	return new Proxy(session, {
		get(target, prop) {
			if (prop === "runEphemeralTurn") return runEphemeralTurn;
			const value: unknown = Reflect.get(target, prop, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

/**
 * Start the SDK's next-message prediction for a session. `choices` resolves with the ready
 * alternatives, most likely first (one unless `composer.predictionAlternatives`), or null when the
 * model skipped, the request failed or timed out, or it was superseded or retired. It resolves as
 * soon as the controller's run ends, offered or not: an offer signals through `requestRender`, every
 * other outcome through the end of the side turn.
 */
function startNextMessagePrediction(
	session: AgentSession,
	meterProvider: ControllerOptions["meterProvider"],
): { live: LivePrediction; choices: Promise<string[] | null> } {
	const { promise, resolve } = Promise.withResolvers<string[] | null>();
	let controller: ComposerPredictionController | undefined;
	let settled = false;
	let timer: NodeJS.Timeout | undefined;
	const settle = (choices: string[] | null): void => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		resolve(choices);
	};
	const settleFromController = (): void =>
		settle(controller?.choices ? [...controller.choices] : null);
	let started = false;
	const host: PredictionHost = {
		settings: session.settings,
		viewSession: watchEphemeralTurn(
			session,
			() => {
				started = true;
			},
			// The controller's continuation after the side turn is synchronous (usage, parse, offer) and runs
			// in microtasks before this timer, so `choices` is final by then.
			() => {
				setTimeout(settleFromController, 0);
			},
		),
		focusedAgentId: undefined,
		editor: { getText: () => "" },
		// Fires when a prediction is ready and on cancel; `choices` then holds the ready
		// alternatives, most likely first, or is undefined.
		ui: { requestRender: settleFromController },
	};
	const active = new ComposerPredictionController(host as never, {
		deadlineMs: PREDICTION_DEADLINE_MS,
		meterProvider,
	});
	controller = active;
	timer = setTimeout(() => {
		active.cancel();
		settle(null);
	}, PREDICTION_DEADLINE_MS + PREDICTION_SETTLE_GRACE_MS);
	active.request();
	// `request` runs the side turn synchronously up to its first await: one that never started
	// (a setting, a draft, a busy session) has nothing to wait for.
	if (!started) settle(null);
	return {
		live: {
			controller: active,
			retire: () => {
				active.cancel();
				settle(null);
			},
		},
		choices: promise,
	};
}

/** Each session's prediction the composer can still report on; one at a time, replaced by the next request. */
const livePredictions = new WeakMap<SessionEntry, LivePrediction>();
const watchedSessions = new WeakSet<SessionEntry>();

/**
 * Retire the session's live prediction, if any: its metrics resolve as accepted or ignored and a request
 * still waiting answers null. Called when the conversation moves on (a turn or compaction starts, the
 * session is replaced, a new prediction is asked for), as the TUI cancels its controller then.
 */
export function retireComposerPrediction(entry: SessionEntry): void {
	livePredictions.get(entry)?.retire();
	livePredictions.delete(entry);
}

/** Retire the prediction when a turn or a compaction starts: it no longer follows the conversation. */
function retireOnWork(entry: SessionEntry): void {
	if (watchedSessions.has(entry)) return;
	watchedSessions.add(entry);
	entry.session.subscribe((event) => {
		if (
			event.type === "agent_start" ||
			event.type === "auto_compaction_start" ||
			event.type === "manual_compaction_start"
		)
			retireComposerPrediction(entry);
	});
}

/**
 * Composer ghost-text RPCs. Each reads its own gating setting from the session
 * so a stale browser cannot force an engine or a billed request the user
 * switched off.
 */
export function createComposerMethods(
	options: ComposerMethodsOptions = {},
): Record<string, ComposerMethod> {
	const wordPredictors = new WeakMap<SessionEntry, RpcWordPredictor>();

	const wordPredictorFor = (entry: SessionEntry): RpcWordPredictor => {
		let predictor = wordPredictors.get(entry);
		if (!predictor) {
			predictor = new RpcWordPredictor();
			wordPredictors.set(entry, predictor);
		}
		return predictor;
	};

	return {
		// `spelling.autocomplete`: suffix for the prose word ending at the cursor.
		predictWord: async (entry, args) => {
			const { text, cursor } = checkedTextCursor(args[0], args[1]);
			const method = cfgSpellingAutocomplete.get(entry.session.settings);
			const suffix = await wordPredictorFor(entry).predict(method, text, cursor);
			return { suffix };
		},

		predictWordFeedback: async (entry, args) => {
			const [, , suggestion, accepted] = args;
			const { text, cursor } = checkedTextCursor(args[0], args[1]);
			if (typeof suggestion !== "string" || typeof accepted !== "boolean")
				throw new Error("suggestion must be a string and accepted a boolean");
			const method = cfgSpellingAutocomplete.get(entry.session.settings);
			if (method === "off") return {};
			const query = wordQueryAt(text, cursor);
			if (query)
				textPredictionBackend(method).feedback(query.before, query.prefix, suggestion, accepted);
			return {};
		},

		// `composer.predictions`: an ephemeral side turn on the session's model and
		// context, run by the SDK's own controller so prompt, effort, usage ledger and
		// staleness rules match the TUI. A newer call supersedes the one in flight,
		// which answers null.
		predictNextMessage: async (entry): Promise<PredictNextMessageReply> => {
			retireComposerPrediction(entry);
			const session = entry.session;
			if (!cfgComposerPredictions.get(session.settings)) return { text: null };
			if (!session.model || session.isStreaming || session.isCompacting) return { text: null };
			retireOnWork(entry);
			const { live, choices } = startNextMessagePrediction(session, options.meterProvider);
			livePredictions.set(entry, live);
			const ready = await choices;
			if (!ready?.length) return { text: null };
			// `choices` rides only when there are alternatives; `text` stays the first for older clients.
			return ready.length > 1 ? { text: ready[0]!, choices: ready } : { text: ready[0]! };
		},

		// The composer painted the live prediction (ghost or `⇥ N more` hint) for the first time: the
		// controller counts it as shown once. Nothing live, nothing to count.
		predictionShown: async (entry) => {
			livePredictions.get(entry)?.controller.shown();
			return {};
		},

		// Tab, Right or the alternatives list inserted alternative `rank`; the last insert before the
		// prediction retires is the one counted.
		predictionAccepted: async (entry, args) => {
			const rank = args[0];
			if (typeof rank !== "number" || !Number.isInteger(rank) || rank < 0)
				throw new Error("rank must be a non-negative integer");
			const live = livePredictions.get(entry);
			const offered = live?.controller.choices;
			if (!live || !offered) return {};
			if (rank >= offered.length)
				throw new Error("rank is not one of the prediction's alternatives");
			live.controller.accepted(rank);
			return {};
		},
	};
}
