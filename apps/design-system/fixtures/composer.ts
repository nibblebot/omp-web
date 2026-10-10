import type { AcItem } from "../../web/components/chat/composer/AutocompletePopup";

/** Slash-command rows as the composer lists them (label, detail, text inserted on apply). */
export const slashCommandItems: AcItem[] = [
	{ label: "/model", detail: "Switch the active model", apply: "/model " },
	{ label: "/thinking", detail: "Set reasoning effort for the next turn", apply: "/thinking " },
	{ label: "/compact", detail: "Summarize the transcript to free context", apply: "/compact " },
	{ label: "/resume", detail: "Pick an earlier session to resume", apply: "/resume " },
	{ label: "/review", detail: "Review the staged changes", apply: "/review " },
];

/** A full command list, long enough to scroll inside the popup. */
export const longSlashCommandItems: AcItem[] = [
	...slashCommandItems,
	{ label: "/new", detail: "Start a new session in this project", apply: "/new " },
	{ label: "/fork", detail: "Branch the conversation from an earlier turn", apply: "/fork " },
	{ label: "/tree", detail: "Browse the session tree", apply: "/tree " },
	{ label: "/settings", detail: "Open the settings panel", apply: "/settings " },
	{ label: "/plan", detail: "Toggle plan mode", apply: "/plan " },
	{ label: "/usage", detail: "Show token usage and cost", apply: "/usage " },
	{ label: "/export", detail: "Export the transcript to HTML", apply: "/export " },
	{ label: "/copy", detail: "Copy the last assistant reply", apply: "/copy " },
	{ label: "/init", detail: "Create an AGENTS.md for this repo", apply: "/init " },
];

/** Repo paths as the @-file completer lists them for this project. */
export const fileMentionItems: AcItem[] = [
	"apps/web/components/chat/composer/PromptComposer.tsx",
	"apps/web/components/chat/composer/AutocompletePopup.tsx",
	"apps/web/components/chat/composer/usePromptAutocomplete.ts",
	"apps/web/state.ts",
	"apps/design-system/fixtures/screen.ts",
].map((path) => ({ label: `@${path}`, apply: `@${path} ` }));
