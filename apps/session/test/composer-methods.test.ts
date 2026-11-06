import { describe, expect, test } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent";
import {
	cfgComposerPredictionAlternatives,
	cfgComposerPredictions,
	cfgSpellingAutocomplete,
} from "@oh-my-pi/pi-coding-agent/modes/settings";
import { createComposerMethods, retireComposerPrediction } from "../composer-methods";
import type { SessionEntry } from "../session-entry";

function entryWith(settings: Settings): SessionEntry {
	return { session: { settings } } as unknown as SessionEntry;
}

describe("composer ghost-text RPC argument checks", () => {
	test("predictWord rejects a cursor past the end of the text", async () => {
		const settings = Settings.isolated();
		const methods = createComposerMethods();
		await expect(methods.predictWord!(entryWith(settings), ["abc", 9])).rejects.toThrow(
			"cursor must be an integer UTF-16 offset within text",
		);
	});

	test("predictWord rejects a non-integer cursor", async () => {
		const settings = Settings.isolated();
		const methods = createComposerMethods();
		await expect(methods.predictWord!(entryWith(settings), ["abc", 1.5])).rejects.toThrow(
			"cursor must be an integer UTF-16 offset within text",
		);
	});

	test("predictWordFeedback rejects a non-boolean accepted flag", async () => {
		const settings = Settings.isolated();
		const methods = createComposerMethods();
		await expect(
			methods.predictWordFeedback!(entryWith(settings), ["abc", 3, "d", "yes"]),
		).rejects.toThrow("suggestion must be a string and accepted a boolean");
	});
});

describe("composer ghost-text RPC gating", () => {
	test("predictWordFeedback is a no-op when spelling.autocomplete is off", async () => {
		const settings = Settings.isolated();
		cfgSpellingAutocomplete.set(settings, "off");
		const methods = createComposerMethods();
		expect(await methods.predictWordFeedback!(entryWith(settings), ["abc", 3, "d", true])).toEqual(
			{},
		);
	});

	test("predictNextMessage answers null while composer.predictions is off (default)", async () => {
		const settings = Settings.isolated();
		const methods = createComposerMethods();
		expect(await methods.predictNextMessage!(entryWith(settings), [])).toEqual({ text: null });
	});

	test("predictNextMessage answers null without a model even when enabled", async () => {
		const settings = Settings.isolated();
		cfgComposerPredictions.set(settings, true);
		const methods = createComposerMethods();
		const entry = {
			session: { settings, model: undefined, isStreaming: false, isCompacting: false },
		};
		expect(await methods.predictNextMessage!(entry as unknown as SessionEntry, [])).toEqual({
			text: null,
		});
	});
});

/** What the fake session's ephemeral side turn does: answers `replyText`, or throws, or edits the conversation first. */
type SideTurn = (session: { messages: unknown[] }) => Promise<string> | string;

/** A session as the SDK prediction controller sees it, with its event listeners captured. */
function predictingSession(settings: Settings, sideTurn: SideTurn) {
	const listeners = new Set<(event: { type: string }) => void>();
	const session = {
		settings,
		model: { provider: "test", id: "model" },
		isStreaming: false,
		isCompacting: false,
		messages: [{ role: "assistant", content: [] }] as unknown[],
		sessionManager: {
			getSessionId: () => "sess",
			getLeafId: () => "leaf",
			appendModelUsage: () => {},
		},
		subscribe: (listener: (event: { type: string }) => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		ephemeralMaxTokensPreservesRequest: () => true,
		runEphemeralTurn: async () => ({
			replyText: await sideTurn(session),
			assistantMessage: { api: "test", provider: "test", model: "model", usage: {} },
		}),
	};
	return {
		entry: { session } as unknown as SessionEntry,
		/** Deliver a session event to the subscribers, as the SDK does. */
		emit: (type: string) => {
			for (const listener of listeners) listener({ type });
		},
	};
}

/** A metrics sink that keeps every counter increment and histogram sample. */
function recordingMeterProvider() {
	const points: { name: string; value: number; attributes: Record<string, unknown> }[] = [];
	const instrument = (name: string) => {
		const record = (value: number, attributes: Record<string, unknown> = {}) => {
			points.push({ name, value, attributes });
		};
		return { add: record, record };
	};
	return {
		provider: {
			getMeter: () => ({ createCounter: instrument, createHistogram: instrument }),
		} as unknown as NonNullable<Parameters<typeof createComposerMethods>[0]>["meterProvider"],
		named: (name: string) => points.filter((point) => point.name === name),
	};
}

describe("composer next-message prediction", () => {
	/** A session whose ephemeral side turn replies `reply`, as the SDK prediction controller sees it. */
	function predictingEntry(settings: Settings, reply: string): SessionEntry {
		return predictingSession(settings, () => reply).entry;
	}

	test("answers the ready prediction", async () => {
		const settings = Settings.isolated();
		cfgComposerPredictions.set(settings, true);
		const methods = createComposerMethods();
		expect(
			await methods.predictNextMessage!(predictingEntry(settings, "Run the tests"), []),
		).toEqual({ text: "Run the tests" });
	});

	test("with alternatives on, answers every alternative in order and text is the first", async () => {
		const settings = Settings.isolated();
		cfgComposerPredictions.set(settings, true);
		cfgComposerPredictionAlternatives.set(settings, true);
		const methods = createComposerMethods();
		expect(
			await methods.predictNextMessage!(
				predictingEntry(settings, "Run the tests\nCommit the change\nOpen a PR"),
				[],
			),
		).toEqual({
			text: "Run the tests",
			choices: ["Run the tests", "Commit the change", "Open a PR"],
		});
	});

	test("with alternatives on, at most four distinct alternatives are answered", async () => {
		const settings = Settings.isolated();
		cfgComposerPredictions.set(settings, true);
		cfgComposerPredictionAlternatives.set(settings, true);
		const methods = createComposerMethods();
		expect(
			await methods.predictNextMessage!(
				predictingEntry(settings, "a one\nA ONE!\nb two\nc three\nd four\ne five"),
				[],
			),
		).toEqual({ text: "a one", choices: ["a one", "b two", "c three", "d four"] });
	});

	test("with alternatives on but one usable line, answers no choices", async () => {
		const settings = Settings.isolated();
		cfgComposerPredictions.set(settings, true);
		cfgComposerPredictionAlternatives.set(settings, true);
		const methods = createComposerMethods();
		expect(
			await methods.predictNextMessage!(predictingEntry(settings, "Run the tests"), []),
		).toEqual({ text: "Run the tests" });
	});

	test("with alternatives off, the reply is one prediction and carries no choices", async () => {
		const settings = Settings.isolated();
		cfgComposerPredictions.set(settings, true);
		const methods = createComposerMethods();
		const reply = await methods.predictNextMessage!(
			predictingEntry(settings, "Run the tests\nCommit the change"),
			[],
		);
		expect(reply).toEqual({ text: "Run the tests Commit the change" });
		expect(reply).not.toHaveProperty("choices");
	});
});

describe("composer next-message prediction that ends without an offer", () => {
	/** Prediction on, alternatives on or off. */
	function enabled(alternatives = false): Settings {
		const settings = Settings.isolated();
		cfgComposerPredictions.set(settings, true);
		cfgComposerPredictionAlternatives.set(settings, alternatives);
		return settings;
	}

	/** Runs the call and reports how long it took to answer. */
	async function timed(entry: SessionEntry) {
		const started = performance.now();
		const reply = await createComposerMethods().predictNextMessage!(entry, []);
		return { reply, ms: performance.now() - started };
	}

	test("a model that skips answers null at once, not at the settle fallback", async () => {
		const { reply, ms } = await timed(predictingSession(enabled(), () => "NO_PREDICTION").entry);
		expect(reply).toEqual({ text: null });
		expect(ms).toBeLessThan(500);
	});

	test("a reply with nothing usable answers null at once", async () => {
		const { reply, ms } = await timed(predictingSession(enabled(true), () => "   \n  ").entry);
		expect(reply).toEqual({ text: null });
		expect(ms).toBeLessThan(500);
	});

	test("a failing side turn answers null at once", async () => {
		const failing = predictingSession(enabled(), () => {
			throw new Error("provider down");
		});
		const { reply, ms } = await timed(failing.entry);
		expect(reply).toEqual({ text: null });
		expect(ms).toBeLessThan(500);
	});

	test("a conversation that moved on during the side turn answers null at once", async () => {
		const moving = predictingSession(enabled(), (session) => {
			session.messages.push({ role: "user", content: "typed meanwhile" });
			return "Run the tests";
		});
		const { reply, ms } = await timed(moving.entry);
		expect(reply).toEqual({ text: null });
		expect(ms).toBeLessThan(500);
	});

	test("a prediction that was skipped has nothing for the composer to report", async () => {
		const meter = recordingMeterProvider();
		const methods = createComposerMethods({ meterProvider: meter.provider });
		const { entry } = predictingSession(enabled(), () => "NO_PREDICTION");
		await methods.predictNextMessage!(entry, []);
		await methods.predictionShown!(entry, []);
		await methods.predictionAccepted!(entry, [0]);
		expect(meter.named("omp.composer.prediction.shown")).toEqual([]);
		expect(meter.named("omp.composer.prediction.resolved")).toEqual([]);
		expect(meter.named("omp.composer.prediction.requests")).toHaveLength(1);
	});
});

describe("composer prediction metrics feedback", () => {
	const THREE = "Run the tests\nCommit the change\nOpen a PR";

	function alternativesOn(): Settings {
		const settings = Settings.isolated();
		cfgComposerPredictions.set(settings, true);
		cfgComposerPredictionAlternatives.set(settings, true);
		return settings;
	}

	/** A session with a ready three-alternative prediction and a recording metrics sink. */
	async function withPrediction() {
		const meter = recordingMeterProvider();
		const methods = createComposerMethods({ meterProvider: meter.provider });
		const session = predictingSession(alternativesOn(), () => THREE);
		const reply = await methods.predictNextMessage!(session.entry, []);
		expect(reply).toMatchObject({ text: "Run the tests" });
		return { meter, methods, ...session };
	}

	test("shown, accepted, then a turn starting records the accepted alternative", async () => {
		const { meter, methods, entry, emit } = await withPrediction();
		await methods.predictionShown!(entry, []);
		await methods.predictionAccepted!(entry, [1]);
		expect(meter.named("omp.composer.prediction.resolved")).toEqual([]);
		emit("agent_start");
		expect(meter.named("omp.composer.prediction.shown")).toEqual([
			{
				name: "omp.composer.prediction.shown",
				value: 1,
				attributes: {
					"omp.composer.prediction.model": "test/model",
					"omp.composer.prediction.choices": 3,
				},
			},
		]);
		expect(meter.named("omp.composer.prediction.resolved")).toEqual([
			{
				name: "omp.composer.prediction.resolved",
				value: 1,
				attributes: {
					"omp.composer.prediction.result": "accepted",
					"omp.composer.prediction.model": "test/model",
					"omp.composer.prediction.choices": 3,
					"omp.composer.prediction.rank": 1,
				},
			},
		]);
		expect(meter.named("omp.composer.prediction.accept.delay")).toHaveLength(1);
	});

	test("the last insert before the prediction retires is the one counted", async () => {
		const { meter, methods, entry, emit } = await withPrediction();
		await methods.predictionShown!(entry, []);
		await methods.predictionAccepted!(entry, [0]);
		await methods.predictionAccepted!(entry, [2]);
		emit("agent_start");
		const [resolved] = meter.named("omp.composer.prediction.resolved");
		expect(resolved?.attributes["omp.composer.prediction.rank"]).toBe(2);
	});

	test("a shown prediction that retires without an insert is ignored", async () => {
		const { meter, methods, entry, emit } = await withPrediction();
		await methods.predictionShown!(entry, []);
		await methods.predictionShown!(entry, []);
		emit("auto_compaction_start");
		expect(meter.named("omp.composer.prediction.shown")).toHaveLength(1);
		const [resolved] = meter.named("omp.composer.prediction.resolved");
		expect(resolved?.attributes["omp.composer.prediction.result"]).toBe("ignored");
	});

	test("a prediction nobody saw resolves to nothing", async () => {
		const { meter, emit } = await withPrediction();
		emit("agent_start");
		expect(meter.named("omp.composer.prediction.shown")).toEqual([]);
		expect(meter.named("omp.composer.prediction.resolved")).toEqual([]);
	});

	test("a new request retires the earlier prediction", async () => {
		const { meter, methods, entry } = await withPrediction();
		await methods.predictionShown!(entry, []);
		await methods.predictNextMessage!(entry, []);
		const [resolved] = meter.named("omp.composer.prediction.resolved");
		expect(resolved?.attributes["omp.composer.prediction.result"]).toBe("ignored");
	});

	test("a replaced session retires the prediction", async () => {
		const { meter, methods, entry } = await withPrediction();
		await methods.predictionShown!(entry, []);
		await methods.predictionAccepted!(entry, [0]);
		retireComposerPrediction(entry);
		const [resolved] = meter.named("omp.composer.prediction.resolved");
		expect(resolved?.attributes["omp.composer.prediction.result"]).toBe("accepted");
		// Nothing is live any more.
		await methods.predictionAccepted!(entry, [1]);
		retireComposerPrediction(entry);
		expect(meter.named("omp.composer.prediction.resolved")).toHaveLength(1);
	});

	test("a prediction the conversation moved past can no longer be reported", async () => {
		const { meter, methods, entry } = await withPrediction();
		(entry.session.messages as unknown[]).push({ role: "user", content: "sent" });
		await methods.predictionShown!(entry, []);
		await methods.predictionAccepted!(entry, [0]);
		expect(meter.named("omp.composer.prediction.shown")).toEqual([]);
		retireComposerPrediction(entry);
		expect(meter.named("omp.composer.prediction.resolved")).toEqual([]);
	});

	test("predictionAccepted rejects a rank that is not a non-negative integer", async () => {
		const { methods, entry } = await withPrediction();
		for (const rank of [-1, 1.5, "0", null, undefined, Number.NaN]) {
			await expect(methods.predictionAccepted!(entry, [rank])).rejects.toThrow(
				"rank must be a non-negative integer",
			);
		}
		await expect(methods.predictionAccepted!(entry, [])).rejects.toThrow(
			"rank must be a non-negative integer",
		);
	});

	test("predictionAccepted rejects a rank past the offered alternatives", async () => {
		const { meter, methods, entry, emit } = await withPrediction();
		await methods.predictionShown!(entry, []);
		await expect(methods.predictionAccepted!(entry, [3])).rejects.toThrow(
			"rank is not one of the prediction's alternatives",
		);
		emit("agent_start");
		const [resolved] = meter.named("omp.composer.prediction.resolved");
		expect(resolved?.attributes["omp.composer.prediction.result"]).toBe("ignored");
	});

	test("without a prediction both calls answer and change nothing", async () => {
		const meter = recordingMeterProvider();
		const methods = createComposerMethods({ meterProvider: meter.provider });
		const { entry } = predictingSession(alternativesOn(), () => THREE);
		expect(await methods.predictionShown!(entry, [])).toEqual({});
		expect(await methods.predictionAccepted!(entry, [0])).toEqual({});
		retireComposerPrediction(entry);
		expect(meter.named("omp.composer.prediction.shown")).toEqual([]);
		expect(meter.named("omp.composer.prediction.resolved")).toEqual([]);
	});
});
