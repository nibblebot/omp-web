/**
 * What the transcript derives from its item list: the consolidated tool runs
 * (tool-runs.ts), the folded wait runs (wait-runs.ts), per-assistant turn
 * metadata (turn-usage.ts), the cards the open Activities panel hides, and the
 * card that started a job. The stream asks per item id; a row subscribes to its
 * own answer only, so an append or a status flip re-renders the rows whose
 * answer changed, not every row of the transcript.
 *
 * The derivation itself is the pure builders over the raw (unwrapped) item
 * list. It runs untracked except for what can change after an item was pushed:
 * the list's structure and, per tool item, `status`, `details` and
 * `background`. Every other field of every item kind is written once, when the
 * item is pushed (an assistant item is never patched), so it is read without a
 * subscription: the transcript holds a handful of signals per tool item instead
 * of one per field of every item. A change recomputes the maps (a raw pass, no
 * proxy reads), keeps the objects of every run that did not change, and fires
 * the per-id signals of the ids whose answer did.
 */
import {
	$PROXY,
	$TRACK,
	batch,
	createComputed,
	createRoot,
	createSignal,
	getOwner,
	on,
	onCleanup,
	runWithOwner,
	untrack,
	type Owner,
} from "solid-js";
import { unwrap } from "solid-js/store";
import type { ChatItem, ToolItem } from "../state";
import { hiddenWhileActivitiesOpen } from "./activity-cards";
import { originJobIds } from "./background-job";
import { indexToolRuns, type Run } from "./tool-runs";
import { sameTranscript } from "./transcript-window";
import { buildTurnMeta, type TurnMeta } from "./turn-usage";
import { buildWaitRuns, type WaitFoldOptions, type WaitRun } from "./wait-runs";

/** A member of a run whose card draws at the run's first call (`lead` is that call's item id): it draws nothing itself. */
export interface RunMember {
	readonly lead: number;
}

export type ToolSlot = Run | RunMember;
export type WaitSlot = WaitRun | RunMember;

export function isRunMember(slot: object): slot is RunMember {
	return "lead" in slot;
}

/** What the index derives from; read in a tracking scope, so a change recomputes it. */
export interface TranscriptIndexOptions {
	/** Consolidated tool cards mode. */
	consolidated: boolean;
	/** `display.hideToolActivity`: no call draws, so no run forms. */
	hideToolActivity: boolean;
	/** The open Activities panel shows these cards instead (the main stream only). */
	hideActivityCards: boolean;
	hideThinking: boolean;
	proseOnlyThinking: boolean;
	showTokenUsage: boolean;
	/** `display.showTurnTime`. */
	turnTime: boolean;
	/** `display.cacheMissMarker`. */
	cacheMiss: boolean;
}

export interface TranscriptIndex {
	/** The tool item's consolidated-run slot: its run at the run's first call, a member elsewhere; undefined outside any run. */
	toolSlot(id: number): ToolSlot | undefined;
	/** The wait item's folded-run slot: the run at its first call, a member elsewhere; undefined for any other item. */
	waitSlot(id: number): WaitSlot | undefined;
	/** The wait run led by the call `id`, for the cards inside a tool run. */
	waitRunLed(id: number): WaitRun | undefined;
	/** Whether a tool run consumed the assistant message: its thinking draws in the run row. */
	consumed(id: number): boolean;
	turnMeta(id: number): TurnMeta | undefined;
	/** Whether the open Activities panel hides this card. */
	hidden(id: number): boolean;
	/** Counts up whenever the set of hidden cards changes, so the stream can keep an unpinned viewport in place. */
	hiddenRev(): number;
	/** The tool item whose result started `jobId`, or undefined. Re-evaluates when a result lands. */
	originOf(jobId: string): ToolItem | undefined;
	/** The first call (item id) of the run the item belongs to, read without subscribing; its own id when it is not a member. */
	leadOf(id: number): number;
}

/** A per-id answer map: a reader subscribes to its id only, the writer fires the ids that changed. */
interface Keyed<V extends object | true> {
	get(id: number): V | undefined;
	peek(id: number): V | undefined;
	/** Replace the answers; objects equal to the previous answer of their id are kept, and only changed ids fire. Returns whether any id changed. */
	replace(next: Map<number, V>, same: (a: V, b: V) => boolean): boolean;
}

function createKeyed<V extends object | true>(): Keyed<V> {
	interface Entry {
		read(): void;
		write(): void;
		refs: number;
	}
	const entries = new Map<number, Entry>();
	let current: ReadonlyMap<number, V> = new Map();
	return {
		get(id) {
			let entry = entries.get(id);
			if (entry === undefined) {
				const [read, write] = createSignal<void>(undefined, { equals: false });
				entry = { read, write: () => write(), refs: 0 };
				entries.set(id, entry);
			}
			entry.read();
			// A reader that goes away takes its signal with it: ids of rows that
			// unmounted must not accumulate.
			if (getOwner() !== null) {
				const held = entry;
				held.refs++;
				onCleanup(() => {
					if (--held.refs <= 0 && entries.get(id) === held) entries.delete(id);
				});
			}
			return current.get(id);
		},
		peek: (id) => current.get(id),
		replace(next, same) {
			const prev = current;
			current = next;
			let changed = false;
			batch(() => {
				for (const [id, value] of next) {
					const before = prev.get(id);
					if (before !== undefined && same(before, value)) next.set(id, before);
					else {
						changed = true;
						entries.get(id)?.write();
					}
				}
				for (const id of prev.keys()) {
					if (next.has(id)) continue;
					changed = true;
					entries.get(id)?.write();
				}
			});
			return changed;
		},
	};
}

const sameValues = <T>(a: readonly T[], b: readonly T[]): boolean =>
	a.length === b.length && a.every((value, i) => value === b[i]);

function sameRun(a: Run, b: Run): boolean {
	return (
		a.key === b.key &&
		a.turnCount === b.turnCount &&
		a.requestCount === b.requestCount &&
		a.errorCount === b.errorCount &&
		a.durationMs === b.durationMs &&
		a.running === b.running &&
		sameValues(a.tools, b.tools) &&
		sameValues(a.thinking, b.thinking) &&
		sameValues(a.consumedAssistantIds, b.consumedAssistantIds)
	);
}

const sameWaitRun = (a: WaitRun, b: WaitRun): boolean => sameValues(a.items, b.items);

function sameSlot<R extends object>(
	a: R | RunMember,
	b: R | RunMember,
	sameLead: (a: R, b: R) => boolean,
): boolean {
	if (isRunMember(a) || isRunMember(b))
		return isRunMember(a) && isRunMember(b) && a.lead === b.lead;
	return a === b || sameLead(a, b);
}

const sameMeta = (a: TurnMeta, b: TurnMeta): boolean =>
	a.turnMs === b.turnMs && a.cacheMissTokens === b.cacheMissTokens;

/** The store's proxy of a raw item (every tool item has been read through the list before this runs), or the item itself outside a store. */
const viewOf = (tool: ToolItem): ToolItem =>
	((tool as unknown as Record<symbol, ToolItem | undefined>)[$PROXY] ?? tool) as ToolItem;

const NO_WAIT: ReadonlyMap<number, WaitRun> = new Map();

/** Tool names whose result can carry the job frame an origin lookup reads. */
const JOB_CALLS: Record<string, true> = { bash: true, eval: true, task: true };

/** Read what can change on a tool item after it was pushed, through the store's proxy of it. */
function trackTool(tool: ToolItem): void {
	void tool.status;
	void tool.details;
	void tool.background?.state;
}

export function createTranscriptIndex(
	items: () => readonly ChatItem[],
	options: () => TranscriptIndexOptions,
): TranscriptIndex {
	const toolSlots = createKeyed<ToolSlot>();
	const waitSlots = createKeyed<WaitSlot>();
	const consumed = createKeyed<true>();
	const turnMeta = createKeyed<TurnMeta>();
	const hidden = createKeyed<true>();
	const [hiddenRev, setHiddenRev] = createSignal(0);
	const [originsRev, setOriginsRev] = createSignal(0);
	// Kept between runs so an unchanged run keeps its object (rows of other runs never re-render).
	let toolRuns = new Map<number, { raw: Run; view: Run }>();
	let waitRuns = new Map<number, { raw: WaitRun; view: WaitRun }>();
	// What the origin lookup last read: rebuilt only when a call that can start a job gets a result.
	const seenDetails = new WeakMap<object, unknown>();
	let origins: Map<string, ToolItem> | undefined;
	let rawItems: readonly ChatItem[] = [];
	// One small computation per tool item watches its mutable fields and asks the
	// derivation to run again; it re-subscribes only when its own item changed, so
	// an append never re-reads the signals of the tools already in the list.
	const [changes, signalChange] = createSignal(0);
	interface Watchers {
		watched: WeakSet<object>;
		owner: Owner;
		dispose(): void;
	}
	let watchers: Watchers | undefined;
	let watchedList: readonly ChatItem[] | undefined;
	onCleanup(() => watchers?.dispose());
	const noteDetails = (tool: ToolItem): void => {
		if (JOB_CALLS[tool.name] !== true || seenDetails.get(tool) === tool.details) return;
		seenDetails.set(tool, tool.details);
		origins = undefined;
		setOriginsRev((rev) => rev + 1);
	};
	const watch = (at: Watchers, tool: ToolItem, view: ToolItem): void => {
		at.watched.add(tool);
		noteDetails(tool);
		runWithOwner(at.owner, () =>
			createComputed(
				on(
					() => trackTool(view),
					() => {
						noteDetails(tool);
						signalChange((n) => n + 1);
					},
					{ defer: true },
				),
			),
		);
	};

	createComputed(() => {
		const list = items();
		const opts = options();
		// The list's structure: an append, or any other write to the array itself.
		void (list as unknown as Record<symbol, unknown>)[$TRACK];
		void list.length;
		void changes();
		const raw = unwrap(list) as readonly ChatItem[];
		rawItems = raw;

		if (!sameTranscript(watchedList, raw)) {
			// Another transcript: its items are watched afresh.
			watchers?.dispose();
			watchers = createRoot((dispose) => ({
				watched: new WeakSet(),
				owner: getOwner()!,
				dispose,
			}));
		}
		// A resync into a new array keeps the watchers of the items it kept.
		watchedList = raw;
		for (let i = 0; i < raw.length; i++) {
			const item = raw[i]!;
			if (item.kind === "tool" && !watchers!.watched.has(item)) {
				watch(watchers!, item, untrack(() => list[i]) as ToolItem);
			}
		}

		const meta = buildTurnMeta(raw, { turnTime: opts.turnTime, cacheMiss: opts.cacheMiss });
		const fold: WaitFoldOptions = {
			hideThinking: opts.hideThinking,
			proseOnlyThinking: opts.proseOnlyThinking,
			showTokenUsage: opts.showTokenUsage,
			turnMeta: meta,
		};
		const waitFull = opts.hideToolActivity ? NO_WAIT : buildWaitRuns(raw, fold);

		const hiddenIds = new Map<number, true>();
		let drawn = raw;
		if (opts.hideActivityCards) {
			drawn = raw.filter((item) => {
				if (!hiddenWhileActivitiesOpen(item)) return true;
				hiddenIds.set(item.id, true);
				return false;
			});
		}
		const toolIndex = indexToolRuns(drawn, {
			consolidated: opts.consolidated,
			hideToolActivity: opts.hideToolActivity,
			waitRuns: waitFull,
		});

		const nextToolRuns = new Map<number, { raw: Run; view: Run }>();
		const toolSlotMap = new Map<number, ToolSlot>();
		for (const [id, run] of toolIndex.runOf) {
			if (run.key !== id) {
				toolSlotMap.set(id, { lead: run.key });
				continue;
			}
			const before = toolRuns.get(id);
			const entry =
				before !== undefined && sameRun(before.raw, run)
					? before
					: { raw: run, view: { ...run, tools: run.tools.map(viewOf) } };
			nextToolRuns.set(id, entry);
			toolSlotMap.set(id, entry.view);
		}
		toolRuns = nextToolRuns;

		const nextWaitRuns = new Map<number, { raw: WaitRun; view: WaitRun }>();
		const waitSlotMap = new Map<number, WaitSlot>();
		for (const [id, run] of waitFull) {
			const lead = run.items[0]!.id;
			if (lead !== id) {
				waitSlotMap.set(id, { lead });
				continue;
			}
			const before = waitRuns.get(id);
			const entry =
				before !== undefined && sameWaitRun(before.raw, run)
					? before
					: { raw: run, view: { items: run.items.map(viewOf) } };
			nextWaitRuns.set(id, entry);
			waitSlotMap.set(id, entry.view);
		}
		waitRuns = nextWaitRuns;

		const consumedMap = new Map<number, true>();
		for (const id of toolIndex.consumedAssistantIds) consumedMap.set(id, true);

		batch(() => {
			toolSlots.replace(toolSlotMap, (a, b) => sameSlot(a, b, sameRun));
			waitSlots.replace(waitSlotMap, (a, b) => sameSlot(a, b, sameWaitRun));
			consumed.replace(consumedMap, () => true);
			turnMeta.replace(new Map(meta), sameMeta);
			if (hidden.replace(hiddenIds, () => true)) setHiddenRev((rev) => rev + 1);
		});
	});

	const ensureOrigins = (): Map<string, ToolItem> => {
		if (origins !== undefined) return origins;
		const found = new Map<string, ToolItem>();
		for (const item of rawItems) {
			if (item.kind !== "tool") continue;
			for (const id of originJobIds(item)) if (!found.has(id)) found.set(id, viewOf(item));
		}
		origins = found;
		return found;
	};

	return {
		toolSlot: (id) => toolSlots.get(id),
		waitSlot: (id) => waitSlots.get(id),
		waitRunLed(id) {
			const slot = waitSlots.get(id);
			return slot === undefined || isRunMember(slot) ? undefined : slot;
		},
		consumed: (id) => consumed.get(id) === true,
		turnMeta: (id) => turnMeta.get(id),
		hidden: (id) => hidden.get(id) === true,
		hiddenRev,
		originOf(jobId) {
			originsRev();
			return ensureOrigins().get(jobId);
		},
		leadOf(id) {
			const slot = toolSlots.peek(id) ?? waitSlots.peek(id);
			return slot !== undefined && isRunMember(slot) ? slot.lead : id;
		},
	};
}
