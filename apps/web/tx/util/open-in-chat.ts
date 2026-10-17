import type { ResumeResolveOutcome } from "../../store/resume";

/**
 * What the transcript's "Open in Chat" button does with a resolved outcome.
 * A unique resume switches the shell to Chat (the transcript lives in
 * Analysis, so without this the click looks like a no-op). Missing, refused,
 * and unknown outcomes stay in Analysis and show the banner text.
 */
export function openInChatEffect(
	outcome: ResumeResolveOutcome,
	id: string,
): { view: "chat" | null; error: string | null } {
	switch (outcome.kind) {
		case "unique":
			return { view: "chat", error: null };
		case "missing":
			return {
				view: null,
				error: `No session matches ${id} (${outcome.searched} searched).`,
			};
		case "refused":
		case "unknown":
			return { view: null, error: outcome.message };
		case "ambiguous":
			return { view: null, error: null };
	}
}
