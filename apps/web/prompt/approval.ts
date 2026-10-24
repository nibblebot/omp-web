import type { UiApprovalAnswer, UiApprovalParams } from "#lib/wire/protocol";

/** One answer the approval bar offers, in display order. */
export interface ApprovalChoice {
	label: string;
	/** Second line under the label: what a remembered grant covers. */
	detail?: string;
	answer: UiApprovalAnswer;
}

/**
 * The choices of an `approve` ui_request, in the order the bar lists them: approve this
 * call, approve for the session (only when the prompt offers it), each grant remembered
 * for this session, each grant remembered across sessions, and Deny last so digit keys
 * and Enter on the first row never deny by accident.
 */
export function approvalChoices(params: UiApprovalParams): ApprovalChoice[] {
	const grants = params.grants ?? [];
	return [
		{ label: grants.length > 0 ? "Approve Once" : "Approve", answer: "once" },
		...(params.session ? [{ label: params.session, answer: "session" as const }] : []),
		...grants.map((grant) => ({
			label: grant.label,
			detail: "Remembered for this session",
			answer: { grant: grant.scope, always: false },
		})),
		...grants.map((grant) => ({
			label: grant.alwaysLabel,
			detail: "Remembered across sessions",
			answer: { grant: grant.scope, always: true },
		})),
		{ label: "Deny", answer: "deny" },
	];
}

/** A prompt is a title line, then the tool call's details (whitespace preserved). */
export function splitApprovalPrompt(full: string): { title: string; details: string } {
	const newline = full.indexOf("\n");
	if (newline < 0) return { title: full, details: "" };
	return { title: full.slice(0, newline), details: full.slice(newline + 1) };
}
