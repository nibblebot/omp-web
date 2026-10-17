/**
 * Transcript-browser hash routes (pure; TranscriptBrowser owns window.location).
 *   #/                                        list (empty hash too)
 *   #/s/<encoded-file>[?sub=<encoded-file>]   session transcript, optional subagent
 *   #/stored/<encoded-ws>/<encoded-session>   fleet-stored session
 * Parse and format share this module so every link we write parses back to the same route.
 */
import { decodeFileFromHash } from "./format";

export type TxRoute =
	| { view: "list" }
	| { view: "session"; file: string; sub: string | null }
	| { view: "stored"; workspaceId: string; sessionId: string };

/** Decode a single individually-encoded path segment; null on malformed input. */
function decodeSegment(encoded: string): string | null {
	try {
		return decodeURIComponent(encoded);
	} catch {
		return null;
	}
}

/** Parse a location hash (with or without the leading "#"). Unknown or malformed routes fall back to the list. */
export function parseTxHash(rawHash: string): TxRoute {
	const hash = rawHash.replace(/^#\/?/, "");
	const qAt = hash.indexOf("?");
	const raw = qAt === -1 ? hash : hash.slice(0, qAt);
	if (raw === "" || raw === "/") return { view: "list" };
	const parts = raw.split("/");
	if (parts[0] === "s") {
		const encoded = parts.slice(1).join("/");
		if (encoded === "") return { view: "list" };
		const file = decodeFileFromHash(encoded);
		if (file === null) return { view: "list" };
		const sub = qAt === -1 ? null : new URLSearchParams(hash.slice(qAt + 1)).get("sub");
		return { view: "session", file, sub: sub || null };
	}
	// #/stored/<workspaceId>/<sessionId>, each exactly one safe segment.
	if (parts[0] === "stored") {
		if (parts.length !== 3) return { view: "list" };
		const wsEncoded = parts[1];
		const sidEncoded = parts[2];
		if (wsEncoded === "" || sidEncoded === "") return { view: "list" };
		const workspaceId = decodeSegment(wsEncoded);
		const sessionId = decodeSegment(sidEncoded);
		if (workspaceId === null || sessionId === null) return { view: "list" };
		return { view: "stored", workspaceId, sessionId };
	}
	return { view: "list" };
}

/** Hash for a fleet-stored session. */
export function storedHash(workspaceId: string, sessionId: string): string {
	return `#/stored/${encodeURIComponent(workspaceId)}/${encodeURIComponent(sessionId)}`;
}
