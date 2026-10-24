/**
 * Browser command table for the fleet edge. Each browser command the edge
 * answers itself declares its wire fields here, in check order; `readEdgeArgs`
 * applies them generically. A field rule either returns the typed value (or
 * `undefined` for an absent optional) or throws OperationError with the bare
 * message. readEdgeArgs prefixes that message with the command name, so the
 * frame reads `<command>: <message>` exactly as the frames always have.
 *
 * Semantic rules (NUL and k=v labels, clone source shape) come from
 * operations.ts, the same rules the control API applies.
 */

import { checkSpawnLabels, OperationError, parseCloneSource } from "./operations";

export type EdgeArgs = Record<string, unknown>;

/** Validates one wire field: `key` names it, `value` is the raw JSON value. */
type FieldRule = (key: string, value: unknown) => unknown;

/** A non-empty string, or a "missing <key>" refusal. */
const required: FieldRule = (key, value) => {
	if (typeof value === "string" && value !== "") return value;
	throw new OperationError(400, `missing ${key}`);
};

/** A non-empty string, or absent. */
const optional: FieldRule = (_key, value) =>
	typeof value === "string" && value !== "" ? value : undefined;

/** Absent, or an integer (range clamping is the handler's). */
const integer: FieldRule = (key, value) => {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isInteger(value)) {
		throw new OperationError(400, `${key} must be an integer`);
	}
	return value;
};

/** `true` or absent; any other value reads as unset. */
const flag: FieldRule = (_key, value) => (value === true ? true : undefined);

/** Absent, or an array of k=v strings with no NUL. */
const labels: FieldRule = (_key, value) => {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || !value.every((label) => typeof label === "string")) {
		throw new OperationError(400, "labels must be an array of k=v strings");
	}
	checkSpawnLabels(value);
	return value;
};

/** Absent, or the exactly-one-member clone source. */
const source: FieldRule = (_key, value) =>
	value === undefined ? undefined : parseCloneSource(value);

/** Absent or empty = unset; a present non-string is refused. */
const deleteBranch: FieldRule = (_key, value) => {
	if (value === undefined) return undefined;
	if (typeof value !== "string") {
		throw new OperationError(400, "deleteBranch must be a branch name");
	}
	return value !== "" ? value : undefined;
};

/**
 * The edge's command table: command name → its fields, in the order the
 * checks run. A command absent from this table is not answered by the edge;
 * it is forwarded to the attached daemon.
 */
export const EDGE_COMMAND_FIELDS: Record<string, Record<string, FieldRule>> = {
	list_daemon_sessions: { daemonId: required, limit: integer },
	list_project_branches: { projectId: required, remote: optional },
	sync_projects: {},
	spawn: { cwd: required, template: optional, labels },
	spawn_resume: { daemonId: required, sessionFile: optional },
	stop: { daemonId: required },
	remove: { daemonId: required },
	add_project: { path: required },
	remove_project: { projectId: required },
	create_clone: {
		projectId: required,
		name: required,
		profileId: required,
		source,
		revision: optional,
		branch: optional,
		start: flag,
	},
	create_worktree: {
		projectId: required,
		name: required,
		baseRef: optional,
		existingBranch: optional,
		start: flag,
	},
	delete_worktree: { daemonId: required, deleteBranch },
	worktree_delete_info: { daemonId: required },
	attach: { sessionId: required },
};

/**
 * Read a command's fields from the raw frame. Present fields are returned by
 * name; absent optionals are omitted. Throws OperationError whose message is
 * already prefixed with the command name.
 */
export function readEdgeArgs(
	command: string,
	fields: Record<string, FieldRule>,
	cmd: Record<string, unknown>,
): EdgeArgs {
	const args: EdgeArgs = {};
	try {
		for (const [key, rule] of Object.entries(fields)) {
			const value = rule(key, cmd[key]);
			if (value !== undefined) args[key] = value;
		}
	} catch (err) {
		if (err instanceof OperationError)
			throw new OperationError(err.status, `${command}: ${err.message}`);
		throw err;
	}
	return args;
}
