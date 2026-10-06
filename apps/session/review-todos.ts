import { createHash } from "node:crypto";
import type { TodoPhase } from "@oh-my-pi/pi-coding-agent/tools";
import {
	applyOpsToPhases,
	getLatestTodoPhasesFromEntries,
	getLatestTodoSnapshotIdentity,
	isTodoPhase,
	markdownToPhases,
	phasesToMarkdown,
	USER_TODO_EDIT_CUSTOM_TYPE,
} from "@oh-my-pi/pi-coding-agent/tools/todo";
import type { TodoBoardDto } from "../../lib/wire/protocol";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { SessionEntry } from "./session-entry";

type SdkTodoOp = Parameters<typeof applyOpsToPhases>[1][number];
export type ReviewTodoOp = SdkTodoOp | { op: "replace"; phases: TodoPhase[] };
type TodoMethod = (entry: SessionEntry, args: unknown[]) => Promise<unknown>;

const OPERATIONS: Record<string, true> = {
	init: true,
	start: true,
	done: true,
	rm: true,
	drop: true,
	block: true,
	unblock: true,
	append: true,
	view: true,
};

function board(entry: SessionEntry): TodoBoardDto {
	const branch = entry.session.sessionManager.getBranch();
	const identity = getLatestTodoSnapshotIdentity(branch);
	// A durable empty board is authoritative too: do not resurrect cached tasks.
	const phases = identity ? getLatestTodoPhasesFromEntries(branch) : entry.session.getTodoPhases();
	return {
		phases,
		revision: identity
			? `${identity.sourceEntryId}:${createHash("sha256").update(identity.fingerprint).digest("hex")}`
			: `runtime:${createHash("sha256").update(JSON.stringify(phases)).digest("hex")}`,
	};
}

function refuse(message: string): never {
	throw Object.assign(new Error(message), { code: "not_eligible" });
}

function input(args: unknown[]): Record<string, unknown> {
	const value = args[0];
	if (!value || typeof value !== "object" || Array.isArray(value))
		refuse("Todo arguments must be an object");
	return value as Record<string, unknown>;
}

function requireRevision(current: TodoBoardDto, baseRevision: unknown): void {
	if (baseRevision !== current.revision) {
		throw Object.assign(new Error("Todo board changed; refresh before editing"), {
			code: "stale",
			currentRevision: current.revision,
		});
	}
}

function stringItems(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function parseOps(value: unknown): ReviewTodoOp[] {
	if (!Array.isArray(value)) refuse("Todo ops must be an array");
	for (const item of value) {
		if (!isRecord(item)) refuse("Each todo op must be an object");
		if (item.op === "replace") {
			if (
				!Array.isArray(item.phases) ||
				!item.phases.every(
					(phase) =>
						isTodoPhase(phase) &&
						phase.tasks.every(
							(task) => task.blocker === undefined || typeof task.blocker === "string",
						),
				)
			)
				refuse("Replacement phases must use the canonical todo model");
			continue;
		}
		if (typeof item.op !== "string" || OPERATIONS[item.op] !== true)
			refuse("Unknown todo operation");
		for (const field of ["task", "phase", "reason"]) {
			if (item[field] !== undefined && typeof item[field] !== "string")
				refuse(`Todo ${field} must be a string`);
		}
		if (item.items !== undefined && !stringItems(item.items)) refuse("Todo items must be strings");
		if (
			item.list !== undefined &&
			(!Array.isArray(item.list) ||
				!item.list.every(
					(phase) =>
						isRecord(phase) &&
						typeof phase.phase === "string" &&
						stringItems(phase.items) &&
						phase.items.length > 0,
				))
		)
			refuse("Todo init list must contain phases with nonempty string items");
	}
	return value as ReviewTodoOp[];
}

function commit(entry: SessionEntry, phases: TodoPhase[], baseRevision: string): TodoBoardDto {
	// No await between the final CAS and canonical append/runtime update. Agent
	// results and other operators cannot interleave a write in this section.
	requireRevision(board(entry), baseRevision);
	entry.session.sessionManager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases });
	entry.session.setTodoPhases(phases);
	return board(entry);
}

export function createTodoMethods(): Record<string, TodoMethod> {
	return {
		todoGet: async (entry) => board(entry),
		todoApply: async (entry, args) => {
			const request = input(args);
			const current = board(entry);
			requireRevision(current, request.baseRevision);
			const ops = parseOps(request.ops);
			let phases = current.phases;
			const errors: string[] = [];
			for (const op of ops) {
				if (op.op === "replace") {
					phases = structuredClone(op.phases);
				} else {
					// SDK owns statuses, targeting, and notably drop (abandon) vs rm.
					const applied = applyOpsToPhases(phases, [op]);
					phases = applied.phases;
					errors.push(...applied.errors);
				}
			}
			if (errors.length > 0) return { phases, errors };
			if (ops.every((op) => op.op === "view")) return current;
			return commit(entry, phases, current.revision);
		},
		todoImport: async (entry, args) => {
			const request = input(args);
			const current = board(entry);
			requireRevision(current, request.baseRevision);
			if (request.confirmed !== true) refuse("Todo import requires explicit confirmation");
			if (typeof request.markdown !== "string") refuse("Todo markdown must be a string");
			const parsed = markdownToPhases(request.markdown);
			if (parsed.errors.length > 0) return parsed;
			return commit(entry, parsed.phases, current.revision);
		},
		todoExport: async (entry) => {
			const current = board(entry);
			return { markdown: phasesToMarkdown(current.phases), revision: current.revision };
		},
	};
}
