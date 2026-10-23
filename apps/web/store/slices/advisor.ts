// Pure slice for advisor notes. Holds the transcript item type
// and the message parser core event handlers call, so state.ts and chat.ts
// never import the advisor UI or actions.

import type { AdvisorNote } from "@oh-my-pi/pi-tui/chat/messages";

/** Advisor notes injected into the primary session (`custom` message, customType "advisor"). */
export type AdvisorItem = { kind: "advisor"; id: number; notes: AdvisorNote[] };

/**
 * Notes of an advisor card message (`role: "custom"`, `customType: "advisor"`,
 * `details.notes`), or null for any other message. Mirrors the TUI's
 * ui-helpers branch: only `display` messages render, and a card with missing
 * details still renders (zero notes).
 */
export function advisorNotesOf(message: unknown): AdvisorNote[] | null {
	const m = message as {
		role?: unknown;
		customType?: unknown;
		display?: unknown;
		details?: { notes?: unknown };
	};
	if (m?.role !== "custom" || m.customType !== "advisor" || !m.display) return null;
	const notes = m.details?.notes;
	if (!Array.isArray(notes)) return [];
	return notes.filter(
		(n): n is AdvisorNote =>
			n !== null && typeof n === "object" && typeof (n as AdvisorNote).note === "string",
	);
}
