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
import type { SessionEntry } from "./session-entry";

/** Mirrors the SDK prediction deadline; the controller aborts its own side turn at this point. */
const PREDICTION_DEADLINE_MS = 15_000;
/** Settles a prediction call whose side turn ended without a ready prediction (the SDK signals only ready ones). */
const PREDICTION_SETTLE_GRACE_MS = 1_000;

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

/** The prediction call currently in flight for one session. */
interface PendingPrediction {
	cancel(): void;
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
 * Start the SDK's next-message prediction for a session. Resolves with the
 * ready prediction, or null when it was skipped, superseded, cancelled, or
 * timed out. The controller signals only a ready prediction, so an empty
 * answer resolves at the settle fallback.
 */
function startNextMessagePrediction(
	session: AgentSession,
	onSettled: (cancel: () => void) => void,
): Promise<string | null> {
	const { promise, resolve } = Promise.withResolvers<string | null>();
	let controller: ComposerPredictionController | undefined;
	let settled = false;
	let timer: NodeJS.Timeout | undefined;
	const settle = (text: string | null): void => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		resolve(text);
	};
	const host: PredictionHost = {
		settings: session.settings,
		viewSession: session,
		focusedAgentId: undefined,
		editor: { getText: () => "" },
		// Fires when a prediction is ready and on cancel; `text` is then the ready prediction or undefined.
		ui: { requestRender: () => settle(controller?.text ?? null) },
	};
	controller = new ComposerPredictionController(host as never, {
		deadlineMs: PREDICTION_DEADLINE_MS,
	});
	const active = controller;
	timer = setTimeout(() => {
		active.cancel();
		settle(null);
	}, PREDICTION_DEADLINE_MS + PREDICTION_SETTLE_GRACE_MS);
	onSettled(() => {
		active.cancel();
		settle(null);
	});
	active.request();
	return promise;
}

/**
 * Composer ghost-text RPCs. Each reads its own gating setting from the session
 * so a stale browser cannot force an engine or a billed request the user
 * switched off.
 */
export function createComposerMethods(): Record<string, ComposerMethod> {
	const wordPredictors = new WeakMap<SessionEntry, RpcWordPredictor>();
	const pendingPredictions = new WeakMap<SessionEntry, PendingPrediction>();

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
		predictNextMessage: async (entry) => {
			pendingPredictions.get(entry)?.cancel();
			const session = entry.session;
			if (!cfgComposerPredictions.get(session.settings)) return { text: null };
			if (!session.model || session.isStreaming || session.isCompacting) return { text: null };
			const text = await startNextMessagePrediction(session, (cancel) =>
				pendingPredictions.set(entry, { cancel }),
			);
			return { text };
		},
	};
}
