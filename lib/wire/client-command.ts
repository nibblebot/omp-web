import type { ClientCommand } from "./protocol";

/**
 * Shape check for an untrusted client command body (POST /command or a
 * callback-pair command envelope). Every ClientCommand variant carries a string
 * `type` and a string `id`; a `call` also needs a string `method` and an array
 * `args` when present. `method` membership is the dispatch table's job
 * (own-property lookup): WebMethodName is a type-only allowlist.
 *
 * Throws on any other shape so callers never dispatch a cast `null`, array, or
 * primitive.
 */
export function parseClientCommand(raw: unknown): ClientCommand {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		throw new Error("command must be a JSON object");
	}
	const { type, id } = raw as { type?: unknown; id?: unknown };
	if (typeof type !== "string" || type === "") throw new Error("command requires a string type");
	if (typeof id !== "string" || id === "") throw new Error("command requires a string id");
	if (type === "call") {
		const { method, args } = raw as { method?: unknown; args?: unknown };
		if (typeof method !== "string" || method === "") {
			throw new Error("call requires a string method");
		}
		if (args !== undefined && !Array.isArray(args)) throw new Error("call args must be an array");
	}
	return raw as ClientCommand;
}
