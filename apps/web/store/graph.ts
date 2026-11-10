import type { ImageArg } from "#lib/wire/protocol";
import { createSignal } from "solid-js";
import { call, connectionState, isSwitching, pushNotice, setPromptInsert, state } from "../state";
import { splitTextAttachments } from "../prompt/attachments";
import { dispatchInput } from "../prompt/commands";
import { composerContent, stashUnsent, type ComposerContent } from "./drafts";
import { openDock } from "./dock";
import { invalidateMentions } from "./models";
import { isReady, isSessionChanging } from "./session";
import { pushToast } from "./toasts";

/** Authoritative session tree, keyed by stable entry IDs. */

/**
 * Browser-side graph vocabulary. Wire `GraphNode.type` (P0-owned) uses
 * "user"|"assistant"|"tool"|"ask"|"compaction"|"model"|"other"; control and
 * summary entries arrive as "other" with the distinction in `label`.
 */
export type GraphNodeKind =
	| "user"
	| "assistant"
	| "tool"
	| "ask"
	| "control"
	| "compaction"
	| "summary"
	| "model"
	| "other";

export interface GraphNode {
	id: string;
	parentId: string | null;
	/** Entry category from the server's graph adapter. */
	type: GraphNodeKind;
	label?: string;
	timestamp: string;
	/** Short human preview (never used as identity). */
	preview: string;
	hasImages: boolean;
	childCount: number;
}

export interface GraphPage {
	sessionId: string;
	parentSession?: string;
	/** Opaque server revision; stale picks against another revision refuse. */
	revision: string;
	leafId: string | null;
	nodes: GraphNode[];
	nextCursor?: string | null;
	hasMore: boolean;
}

export type GraphFilter = "all" | "user" | "conversation" | "tool" | "label";

export interface GraphQuery {
	filter?: GraphFilter;
	text?: string;
	cursor?: string;
	limit?: number;
}

export interface AskReopen {
	toolCallId: string;
	html: string;
}

export type NavigateOutcome =
	| { kind: "navigated"; editorText?: string; editorImages?: ImageArg[]; summaryId?: string }
	| { kind: "branched"; text: string }
	| { kind: "askReopen"; reopen: AskReopen }
	| { kind: "cancelled" };

interface NavigateTreeResult {
	revision: string;
	editorText?: string;
	editorImages?: ImageArg[];
	cancelled?: boolean;
	aborted?: boolean;
	summaryEntry?: { id: string };
	reopenAsk?: AskReopen;
	askReanswerCommitted?: boolean;
}

/**
 * A transcript turn as a turn action names it (the SDK's `TurnMessage`): the message's role
 * and its `timestamp`. The session resolves it to the entry on the current branch.
 */
export interface TurnRef {
	role: "user" | "assistant";
	at: number;
}

/** `rewindTurn`'s answer: the navigation's, plus what an Undo needs. */
interface TurnRewindResult extends NavigateTreeResult {
	entryId: string;
	previousLeafId: string | null;
	rewoundTurns: number;
}

/** How long a rewind's toast, and so its Undo, stays. */
const REWIND_UNDO_MS = 10_000;

/** Generation of the cached graph. Bumped whenever the transcript is
 *  replaced (compact/handoff/branch/clear/fork/reconnect resync), so picks
 *  made against an older page refuse instead of landing on a stale node. */
let generation = 0;
let cachedPage: GraphPage | null = null;
let loadIssue = 0;
const askProbes = new Map<string, { revision: string; generation: number }>();

/** Filter text seeded into the session tree pane when a card has no stable
 * entry ID. Text narrows presentation only; it never selects identity. */
const [treeSeed, setTreeSeed] = createSignal<string | null>(null);

export { treeSeed };

export function seedTreeFilter(text: string): void {
	setTreeSeed(text);
}

/** Take and clear the pending seed; the tree pane applies it to its filter. */
export function takeTreeSeed(): string | null {
	const v = treeSeed();
	if (v !== null) setTreeSeed(null);
	return v;
}

/** Entry id the session tree pane selects once it loads (Rewind to here…). */
const [treeFocus, setTreeFocus] = createSignal<string | null>(null);

export { treeFocus };

/** Take and clear the pending focus; the tree pane selects that node. */
export function takeTreeFocus(): string | null {
	const v = treeFocus();
	if (v !== null) setTreeFocus(null);
	return v;
}

/** Called after any transcript-replacing event the browser can observe
 *  (successful branch/navigate, tree pane mount after reconnect). Clears the
 *  mirror; the next load fetches the authoritative page. */
export function noteTranscriptReplaced(): void {
	generation += 1;
	cachedPage = null;
	askProbes.clear();
}

export function graphGeneration(): number {
	return generation;
}

/** Load an authoritative page with server-side filtering and paging. */
export async function loadGraph(query: GraphQuery = {}): Promise<GraphPage> {
	const gen = generation;
	const issue = ++loadIssue;
	const data = (await call("getSessionGraph", [
		{
			cursor: query.cursor,
			limit: query.limit ?? 100,
			filter: query.filter ?? "all",
			query: query.text ?? "",
		},
	])) as GraphPage;
	if (gen !== generation) throw new Error("graph changed while loading; re-pick");
	// Only the latest-issued load is the mirror a pick validates against; an older
	// answer that arrives late is still returned to its caller, never cached.
	if (issue === loadIssue) cachedPage = data;
	return data;
}

/** Siblings share a parentId. Only meaningful within the loaded page; the
 *  tree pane labels it as such instead of claiming full lineage. */
export function siblingsOf(node: GraphNode, nodes: GraphNode[]): GraphNode[] {
	return nodes.filter(
		(n) => n.id !== node.id && n.parentId === node.parentId && node.parentId !== null,
	);
}

export function childrenOf(node: GraphNode, nodes: GraphNode[]): GraphNode[] {
	return nodes.filter((n) => n.parentId === node.id);
}

/**
 * Same-file navigation (stays in this session file; previous branch kept).
 * With `summarize`, the abandoned path is summarized at the target.
 * Ask toolResults run the full re-answer transaction when the server
 * supports it (probe -> browser ask -> complete -> resume).
 */
export async function navigateToEntry(
	targetId: string,
	opts: { summarize?: boolean; customInstructions?: string } = {},
	pageRevision?: string,
): Promise<NavigateOutcome> {
	const revision = pageRevision ?? cachedPage?.revision;
	if (!revision) throw new Error("Load the session graph before navigating.");
	if (pageRevision !== undefined && cachedPage && pageRevision !== cachedPage.revision) {
		throw new Error("Branch list is stale (session changed); reloaded — please re-pick.");
	}
	const probeGeneration = generation;
	const data = (await call("navigateTree", [
		targetId,
		{
			revision,
			...(opts.summarize ? { summarize: true } : {}),
			...(opts.customInstructions ? { customInstructions: opts.customInstructions } : {}),
			allowAskReopen: true,
		},
	])) as NavigateTreeResult;
	if (data.reopenAsk) {
		if (probeGeneration !== generation) {
			throw new Error("Session changed while reopening the question; re-pick.");
		}
		askProbes.set(targetId, { revision: data.revision, generation: probeGeneration });
		return { kind: "askReopen", reopen: data.reopenAsk };
	}
	if (data.cancelled || data.aborted) return { kind: "cancelled" };
	noteTranscriptReplaced();
	if (data.editorText !== undefined || data.editorImages !== undefined) {
		// Prior text/image draft restore: lands in the composer unsent, never auto-sent.
		setPromptInsert({
			text: data.editorText ?? "",
			...(data.editorImages && data.editorImages.length > 0 ? { images: data.editorImages } : {}),
		});
	}
	return {
		kind: "navigated",
		editorText: data.editorText,
		editorImages: data.editorImages,
		summaryId: data.summaryEntry?.id,
	};
}

/**
 * New-file branch (creates another session file; identity/lineage changes).
 * Labeled accurately at every call site: this is NOT same-file navigation.
 */
export async function branchFromEntry(entryId: string): Promise<NavigateOutcome> {
	let result: { text?: string; cancelled?: boolean } | null;
	try {
		result = (await call("branch", [entryId])) as { text?: string; cancelled?: boolean } | null;
	} catch (err) {
		// Server-authoritative stale refusal: unknown IDs throw server-side.
		throw err instanceof Error ? err : new Error(String(err));
	}
	if (!result || result.cancelled) return { kind: "cancelled" };
	noteTranscriptReplaced();
	pushNotice("info", `Branched to a new session file at: ${(result.text ?? "").slice(0, 200)}`);
	return { kind: "branched", text: result.text ?? "" };
}

/**
 * Ask re-answer, second pass: the session runs the SDK's ask tool against the
 * probed form (the composer shows it), then branches a new sibling toolResult
 * and rebuilds; resume follows. No call deadline: the user may take long.
 * Resolves `false` when the user cancelled the question (nothing changed).
 */
export async function reanswerAsk(targetId: string): Promise<boolean> {
	const probe = askProbes.get(targetId);
	if (!probe || probe.generation !== generation) {
		throw new Error("Ask re-answer is stale; reopen the question from the session graph.");
	}
	askProbes.delete(targetId);
	const data = (await call(
		"reanswerAsk",
		[targetId, { revision: probe.revision }],
		0,
	)) as NavigateTreeResult;
	if (data.cancelled || data.aborted) return false;
	if (!data.askReanswerCommitted)
		throw new Error("Server did not commit the re-answer; nothing changed.");
	noteTranscriptReplaced();
	// Resume only AFTER the transcript rebuild, never before: scheduling the
	// continue here would render the resumed turn against stale UI.
	await call("resumeAfterAskReanswer", []);
	return true;
}

/** A card whose turn the session can resolve branches at that entry; one without (an
 * agent-attributed follow-up) opens the picker, never inferring an identity from display text
 * (even when exactly one preview matches). */
export async function branchFromCard(opts: {
	turn?: TurnRef;
	text: string;
	imageCount: number;
}): Promise<void> {
	if (opts.turn) {
		await branchFromEntry(await turnEntryId(opts.turn));
		return;
	}
	seedTreeFilter(opts.text.slice(0, 80));
	stashUnsent();
	openDock("tree");
	pushNotice("info", "This message has no entry ID — pick the exact node to branch from.");
}

/** The attached session a rewind belongs to: its Undo acts only there. */
function attachedSession(): string {
	return `${state.currentWorkspaceId}:${state.sessionId}`;
}

/** Why a turn action (or its Undo) cannot run now, or null. */
function turnActionRefusal(): string | null {
	if (isSwitching()) return "The session is still loading; try again once it has.";
	if (connectionState() !== "connected") return "Not connected; try again once it reconnects.";
	if (isSessionChanging()) return "The session is still changing; try again in a moment.";
	if (state.streaming) return "Wait for the current response to finish or stop it first.";
	return null;
}

/**
 * A transcript turn's Edit & resend (`edit`) or Retry turn (`retry`), the SDK's `runTurnAction`:
 * a same-file rewind past the turn's prompt (the user message itself, or the last prompt before
 * an answer) without a summary; the previous path stays in the tree. Edit puts the prompt in the
 * composer in place of what it held and toasts the rewind with an Undo; Retry sends the prompt
 * again at once and is refused while the composer holds an unsent draft.
 */
export async function runTurnAction(act: "edit" | "retry", turn: TurnRef): Promise<void> {
	const draft = composerContent();
	const refusal =
		turnActionRefusal() ??
		(act === "retry" && !isReady() ? "The attached session is not ready yet." : null) ??
		(act === "retry" && (draft.text.trim() || draft.images.length > 0 || draft.files.length > 0)
			? "Send or clear the draft to retry this turn"
			: null);
	if (refusal) {
		pushToast(refusal);
		return;
	}
	const owner = attachedSession();
	const result = (await call("rewindTurn", [turn])) as TurnRewindResult;
	if (result.cancelled || result.aborted) {
		pushToast("Navigation cancelled");
		return;
	}
	noteTranscriptReplaced();
	// A switch while the call ran: the answer belongs to the session the page left.
	if (owner !== attachedSession()) return;
	const text = result.editorText ?? "";
	const images = result.editorImages ?? [];
	if (act === "retry") {
		if (text.trim() || images.length > 0) dispatchInput(text, images, "enter");
		pushToast("Retrying the turn");
		return;
	}
	if (result.editorText !== undefined || images.length > 0) {
		// Attached files went out inlined in the prompt; they come back as chips.
		const { text: body, files } = splitTextAttachments(text);
		setPromptInsert({
			text: body,
			...(images.length > 0 ? { images } : {}),
			...(files.length > 0 ? { files } : {}),
			replace: true,
		});
	}
	const turns = result.rewoundTurns;
	pushToast(
		turns > 0 ? `Rewound ${turns} turn${turns === 1 ? "" : "s"}` : "Rewound to selected point",
		{
			durationMs: REWIND_UNDO_MS,
			action: {
				label: "Undo",
				run: () => {
					undoRewind(owner, result.previousLeafId, draft).catch((err) =>
						pushNotice("error", err instanceof Error ? err.message : String(err)),
					);
				},
			},
		},
	);
}

/**
 * Undo of a turn's rewind: the leaf goes back to `leafId`, where it was (the rewind kept that
 * path in the tree, same file, no summary), and `draft`, what the composer held before the
 * rewind put the prompt there, comes back.
 */
async function undoRewind(owner: string, leafId: string | null, draft: ComposerContent) {
	if (owner !== attachedSession()) {
		pushToast("That rewind belongs to another session.");
		return;
	}
	if (!leafId) return;
	const refusal = turnActionRefusal();
	if (refusal) {
		pushToast(refusal);
		return;
	}
	const page = await loadGraph({ limit: 1 });
	const data = (await call("navigateTree", [
		leafId,
		{ revision: page.revision },
	])) as NavigateTreeResult;
	if (data.cancelled || data.aborted) {
		pushToast("Navigation cancelled");
		return;
	}
	noteTranscriptReplaced();
	if (owner !== attachedSession()) return;
	setPromptInsert({ ...draft, replace: true });
	pushToast("Rewind undone");
}

/** Rewind to here…: the session tree pane opens with the turn's entry selected (the web's rewind picker). */
export async function openRewindPicker(turn: TurnRef): Promise<void> {
	setTreeFocus(await turnEntryId(turn));
	openDock("tree");
}

/** The entry id `turn` names on the session's current branch; refused when it is not there. */
async function turnEntryId(turn: TurnRef): Promise<string> {
	// Answer shape of `findTurnEntry` (apps/session/graph-model-adapter.ts).
	const answer = (await call("findTurnEntry", [turn])) as { entryId: string };
	return answer.entryId;
}
