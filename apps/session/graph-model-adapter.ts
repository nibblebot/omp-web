import { createHash } from "node:crypto";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { SessionEntry as SdkEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import {
	deleteModelPreset,
	describeShadowedRoles,
	formatModelPresetSwitch,
	getModelPreset,
	getModelPresetNames,
	modelPresetSavedMessage,
	saveModelPreset,
} from "@oh-my-pi/pi-coding-agent/config/model-presets";
import type { Settings } from "@oh-my-pi/pi-coding-agent";
import type { ModelPresetDetail, ModelPresetsAnswer } from "#lib/wire/protocol";
import { activeModelPreset, applyPinnedModelPreset } from "./model-role-pin";
import type { SessionEntry } from "./session-entry";

function presetDetail(settings: Settings, name: string): ModelPresetDetail {
	// getModelPresetNames only lists names with an owning layer, so a miss is a bug.
	const owned = settings.getOwnedModelPreset(name);
	if (!owned) throw new Error(`Model preset "${name}" is listed but has no owning layer`);
	const lookup = getModelPreset(settings, name);
	switch (lookup.kind) {
		case "found":
			return {
				name,
				source: owned.source,
				modelRoles: { ...lookup.preset.modelRoles },
				...(lookup.preset.defaultThinkingLevel !== undefined
					? { defaultThinkingLevel: lookup.preset.defaultThinkingLevel }
					: {}),
			};
		case "invalid":
			return { name, source: owned.source, modelRoles: {}, invalid: lookup.reason };
		case "missing":
			throw new Error(`Model preset "${name}" is listed but could not be read`);
	}
}

export interface GraphQuery {
	cursor?: string;
	limit?: number;
	filter?: "all" | "user" | "conversation" | "tool" | "label";
	query?: string;
}
export interface GraphNode {
	id: string;
	parentId: string | null;
	type:
		| "user"
		| "assistant"
		| "tool"
		| "ask"
		| "control"
		| "compaction"
		| "summary"
		| "model"
		| "other";
	entryType: SdkEntry["type"];
	label?: string;
	timestamp: string;
	preview: string;
	hasImages: boolean;
	childCount: number;
}
export interface GraphPage {
	sessionId: string;
	revision: string;
	leafId: string | null;
	parentSession?: string;
	nodes: GraphNode[];
	nextCursor: string | null;
	hasMore: boolean;
}
export type GraphNavigateOptions = NonNullable<Parameters<AgentSession["navigateTree"]>[1]> & {
	revision?: string;
};

/**
 * Revision includes content and labels, not only append count or current leaf.
 * Cheap invariants (length, last id, leaf) are unsound: SDK `rewriteEntries()`
 * (session-maintenance, turn-recovery) mutates entries in place, and the only
 * correct counter (`#bodyRevision`) has no public getter. Hashing every entry
 * stays the correct choice until the SDK exposes one.
 */
export function graphRevision(
	sessionId: string,
	leafId: string | null,
	entries: readonly SdkEntry[],
): string {
	return createHash("sha256")
		.update(JSON.stringify([sessionId, leafId, entries]))
		.digest("hex");
}

export function createGraphModelHandlers(deps: {
	/** Publish rebuilt history and await delivery scheduling before permitting ask resume. */
	rebuildTranscript(entry: SessionEntry): Promise<void>;
}) {
	const pendingAnswers = new WeakMap<AgentSession, { targetId: string; revision: string }>();
	const committedAnswers = new WeakMap<AgentSession, string>();
	const revisionOf = (session: AgentSession) =>
		graphRevision(
			session.sessionId,
			session.sessionManager.getLeafId(),
			session.sessionManager.getEntries(),
		);
	return {
		getSessionGraph(entry: SessionEntry, query: GraphQuery = {}): GraphPage {
			const { session } = entry;
			const manager = session.sessionManager;
			const entries = manager.getEntries();
			const leafId = manager.getLeafId();
			const revision = graphRevision(session.sessionId, leafId, entries);
			const filter = query.filter ?? "all";
			const text = query.query ?? "";
			if (!["all", "user", "conversation", "tool", "label"].includes(filter))
				throw new Error("Invalid graph filter");
			const limit = query.limit ?? 100;
			if (!Number.isInteger(limit) || limit < 1 || limit > 500)
				throw new Error("Graph limit must be an integer from 1 to 500");
			const childCounts = new Map<string, number>();
			for (const node of entries)
				if (node.parentId)
					childCounts.set(node.parentId, (childCounts.get(node.parentId) ?? 0) + 1);
			const nodes: GraphNode[] = entries
				.map((node) => {
					let type: GraphNode["type"] = "control";
					let preview: string = node.type;
					let hasImages = false;
					if (node.type === "message") {
						const message = node.message;
						type =
							message.role === "user"
								? "user"
								: message.role === "assistant"
									? "assistant"
									: message.role === "toolResult"
										? message.toolName === "ask"
											? "ask"
											: "tool"
										: "other";
						if ("content" in message) {
							if (typeof message.content === "string") preview = message.content;
							else if (Array.isArray(message.content)) {
								const texts: string[] = [];
								for (const part of message.content) {
									if (part.type === "text") texts.push(part.text);
									else if (part.type === "image") hasImages = true;
									else if (part.type === "toolCall") texts.push(`[${part.name}]`);
								}
								preview = texts.join("\n") || (hasImages ? "[image]" : message.role);
							}
						}
					} else if (node.type === "custom_message") {
						preview =
							typeof node.content === "string"
								? node.content
								: node.content
										.filter((part) => part.type === "text")
										.map((part) => part.text)
										.join("\n");
						hasImages =
							Array.isArray(node.content) && node.content.some((part) => part.type === "image");
					} else if (node.type === "compaction") {
						type = "compaction";
						preview = node.summary;
					} else if (node.type === "branch_summary") {
						type = "summary";
						preview = node.summary;
					} else if (node.type === "model_change" || node.type === "model_usage") type = "model";
					return {
						id: node.id,
						parentId: node.parentId,
						type,
						entryType: node.type,
						label: manager.getLabel(node.id),
						timestamp: node.timestamp,
						preview: preview.slice(0, 160),
						hasImages,
						childCount: childCounts.get(node.id) ?? 0,
					};
				})
				.filter(
					(node) =>
						(filter === "all" ||
							(filter === "user" && node.type === "user") ||
							(filter === "conversation" && (node.type === "user" || node.type === "assistant")) ||
							(filter === "tool" && (node.type === "tool" || node.type === "ask")) ||
							(filter === "label" && !!node.label)) &&
						(!text ||
							`${node.label ?? ""}\n${node.preview}\n${node.id}`
								.toLowerCase()
								.includes(text.toLowerCase())),
				)
				.reverse();
			let start = 0;
			if (query.cursor) {
				let cursor: unknown;
				try {
					cursor = JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8"));
				} catch {
					throw new Error("Invalid graph cursor");
				}
				if (
					!cursor ||
					typeof cursor !== "object" ||
					!("revision" in cursor) ||
					cursor.revision !== revision ||
					!("filter" in cursor) ||
					cursor.filter !== filter ||
					!("query" in cursor) ||
					cursor.query !== text ||
					!("lastId" in cursor) ||
					typeof cursor.lastId !== "string"
				)
					throw new Error("Graph page is stale or belongs to another query; reload");
				const index = nodes.findIndex((node) => node.id === cursor.lastId);
				if (index < 0) throw new Error("Graph cursor entry no longer exists; reload");
				start = index + 1;
			}
			const page = nodes.slice(start, start + limit);
			const hasMore = start + page.length < nodes.length;
			return {
				sessionId: session.sessionId,
				revision,
				leafId,
				parentSession: manager.getHeader()?.parentSession,
				nodes: page,
				hasMore,
				nextCursor: hasMore
					? Buffer.from(
							JSON.stringify({ revision, filter, query: text, lastId: page[page.length - 1].id }),
						).toString("base64url")
					: null,
			};
		},
		async navigateTree(entry: SessionEntry, targetId: string, options: GraphNavigateOptions = {}) {
			const { session } = entry;
			const revision = revisionOf(session);
			if (options.revision !== revision)
				throw new Error("Graph selection is stale; reload and re-pick");
			if (!session.sessionManager.getEntry(targetId))
				throw new Error("Graph entry no longer exists");
			if (options.reanswerAskResult) {
				const pending = pendingAnswers.get(session);
				if (!pending || pending.targetId !== targetId || pending.revision !== revision)
					throw new Error("Ask re-answer has no current probe; reopen the question");
			}
			committedAnswers.delete(session);
			const result = await session.navigateTree(targetId, options);
			if (result.reopenAsk) pendingAnswers.set(session, { targetId, revision });
			else {
				pendingAnswers.delete(session);
				if (!result.cancelled && !result.aborted) {
					await deps.rebuildTranscript(entry);
					if (result.askReanswerCommitted) committedAnswers.set(session, revisionOf(session));
				}
			}
			return {
				editorText: result.editorText,
				editorImages: result.editorImages,
				cancelled: result.cancelled,
				aborted: result.aborted,
				summaryEntry: result.summaryEntry ? { id: result.summaryEntry.id } : undefined,
				reopenAsk: result.reopenAsk,
				askReanswerCommitted: result.askReanswerCommitted,
				revision: revisionOf(session),
			};
		},
		resumeAfterAskReanswer(entry: SessionEntry) {
			const { session } = entry;
			if (committedAnswers.get(session) !== revisionOf(session))
				throw new Error("No rebuilt current ask re-answer to resume");
			committedAnswers.delete(session);
			session.resumeAfterAskReanswer();
			return { resumed: true };
		},
		getModelPresets(entry: SessionEntry): ModelPresetsAnswer {
			const { settings } = entry.session;
			const names = getModelPresetNames(settings);
			return {
				names,
				active: activeModelPreset(settings),
				presets: names.map((name) => presetDetail(settings, name)),
			};
		},
		saveModelPreset(entry: SessionEntry, name: string) {
			saveModelPreset(entry.session.settings, name);
			return { message: modelPresetSavedMessage(entry.session.settings, name) };
		},
		async applyModelPreset(entry: SessionEntry, name: string) {
			const result = await applyPinnedModelPreset(entry.session.settings, entry.session, name);
			if (result.kind !== "switched") throw new Error(formatModelPresetSwitch(name, result));
			return {
				applied: name,
				warnings: describeShadowedRoles(result.shadowed, result.shadowedThinking),
			};
		},
		deleteModelPreset(entry: SessionEntry, name: string) {
			return { result: deleteModelPreset(entry.session.settings, name) };
		},
		getModelMentions(entry: SessionEntry) {
			return { mentions: entry.session.modelMentions.map((mention) => ({ ...mention })) };
		},
	};
}
