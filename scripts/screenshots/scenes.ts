/**
 * The screenshot scene list: the single source of truth for what
 * `bun run screenshots` renders and for which `docs/screenshots/*` files exist.
 * Ids are the file-name contract with README.md (the README image guard test
 * reads `outputFiles()`). Browser-free on purpose: the guard test imports it.
 */

export type Scheme = "light" | "dark";
export const SCHEMES: readonly Scheme[] = ["light", "dark"];

export interface Viewport {
	width: number;
	height: number;
}

/**
 * `desktop` stays at or above the 1024 px layout breakpoint; `phone` is a 412 px
 * wide handset; `panel` is a window just past the 767 px phone-layout breakpoint
 * (no oversized touch targets) for component close-ups; `tall` is a desktop
 * window with room for dialogs that scroll inside 700 px.
 */
export const VIEWPORTS = {
	desktop: { width: 1100, height: 700 },
	tall: { width: 1100, height: 900 },
	phone: { width: 412, height: 915 },
	panel: { width: 800, height: 700 },
} as const satisfies Record<string, Viewport>;
export type ViewportKind = keyof typeof VIEWPORTS;

/** A scripted UI action; every step waits for the page to settle afterwards. Selectors match the first visible element. */
export type AppStep =
	| { wait: string }
	| { gone: string }
	| { click: string }
	| { hover: string }
	| { press: string }
	| { fill: string; text: string }
	| { type: string; text: string };

export type Source =
	/** One component from the design-system stories (`?embed=<story>`); `variant` is the tab (or stacked frame) to show. */
	| { kind: "story"; story: string; variant?: string; steps?: readonly AppStep[] }
	/** The demo App at a hash route, then `steps`. */
	| { kind: "app"; route: string; steps?: readonly AppStep[] };

/** What the PNG covers: an element's box grown by `pad` CSS px, or a page rectangle (CSS px); the viewport when absent. */
export type Clip =
	| { selector: string; pad?: number }
	| { x: number; y: number; width: number; height: number };

export interface StillScene {
	id: string;
	/** One line for the contact sheet: what the shot is meant to show. */
	shows: string;
	source: Source;
	viewport: ViewportKind;
	clip?: Clip;
	/** Selectors that must be visible before the shot is taken: the data the shot is about, never a timeout. */
	ready: readonly string[];
	/** A page expression that must become true too, for state no selector shows (see `THEMES_LOADED`). */
	until?: string;
	/** A story frame's CSS width, narrower than the window: the layout still follows the window's media queries. */
	frameWidth?: number;
}

/** A story variant's frame (the runner strips its border and caption). */
const VARIANT: Clip = { selector: ".ds-variant-body" };
/** A dialog or sheet portalled to the body. */
const MODAL: Clip = { selector: ".modal" };

/** The demo App's rich session: transcript, subagents, jobs, daemons, todos and advisor notes. */
const SESSION = "#/w/dmn_a002/s/sess_09a41c";
const COMPOSER = "textarea[aria-label='Message the agent']";
/** The attached session has finished loading its activity (the chips appear last). */
const LOADED = ".activity-bar-button";
const PALETTE_INPUT = "input.picker-filter";

/** The transcript tail, activity chips and Activities dock: the window without the sidebar. */
const ACTIVITIES_AREA: Clip = { x: 240, y: 0, width: 860, height: 700 };
/** The lower right of the 1100 px desktop window: the transcript tail, activity chips and composer. */
const COMPOSER_AREA: Clip = { x: 240, y: 310, width: 860, height: 390 };

/** Steps that fold these Activities sections shut, leaving the others open, then move the pointer off the header it clicked. */
function foldSections(...ids: readonly string[]): AppStep[] {
	return [
		...ids.map((id) => ({ click: `[data-activity-section='${id}'] .activity-section-toggle` })),
		{ hover: ".activity-bar-status" },
	];
}

/**
 * The generated theme stylesheet holds the dark and light variants the theme stories paint (their
 * halves each take the colors of their own variant). It is rebuilt when the story's theme payload
 * lands, after the first paint.
 */
const THEMES_LOADED = `(() => {
	const css = document.getElementById("omp-themes")?.textContent ?? "";
	return ["catppuccin/dark", "catppuccin/light", "dusk-terminal/dark"].every((v) => css.includes(v));
})()`;

/** CSS width of every tool card close-up, so the shots tile evenly in a gallery. */
const TOOL_CARD_WIDTH = 560;
/** A collapsed tool card shows its header only; a click on the header opens it. */
const OPEN_CARD: readonly AppStep[] = [{ click: ".ds-variant-body summary" }];

/** A tool card close-up: one real card component in a rich, settled state, clipped to its story frame. */
function toolCard(
	name: string,
	shows: string,
	story: string,
	variant: string,
	extra: { steps?: readonly AppStep[]; ready?: string } = {},
): StillScene {
	return {
		id: `tool-${name}`,
		shows,
		source: {
			kind: "story",
			story,
			variant,
			...(extra.steps === undefined ? {} : { steps: extra.steps }),
		},
		viewport: "panel",
		frameWidth: TOOL_CARD_WIDTH,
		clip: VARIANT,
		ready: [extra.ready ?? ".ds-variant-body .tool-card"],
	};
}

/** One shot per built-in omp tool card, all clipped to the same width so they tile in a gallery. */
const TOOL_STILLS: readonly StillScene[] = [
	toolCard(
		"ask",
		"ask: the agent asks two questions and the answers it got",
		"chat-tools-ask-tool-card",
		"Two questions, multi-select",
	),
	toolCard(
		"read",
		"read: a file excerpt with line numbers and highlighting",
		"chat-tools-read-tool-card",
		"Excerpt, short file",
		{ steps: OPEN_CARD, ready: ".read-body .write-line" },
	),
	toolCard(
		"edit",
		"edit: two hunks of one call as a syntax-highlighted diff",
		"chat-tools-diff-tool-card",
		"Two hunks in one call",
		{ steps: OPEN_CARD, ready: ".diff-line[data-type='add'][data-hl]" },
	),
	toolCard("write", "write: a new file's content", "chat-tools-diff-tool-card", "Write, new file", {
		steps: OPEN_CARD,
		ready: ".diff-line[data-type='add']",
	}),
	toolCard(
		"bash",
		"bash: the command and the tail of its output",
		"chat-tools-bash-tool-card",
		"Multi-line command",
	),
	toolCard(
		"eval-js",
		"eval: a JavaScript cell with its output",
		"chat-tools-eval-tool-card",
		"Done (js), table and helper status log",
	),
	toolCard(
		"eval-python",
		"eval: a Python cell; a DataFrame, a dict and Markdown render as views",
		"chat-tools-eval-tool-card",
		"Printed DataFrame, dict and Markdown",
	),
	toolCard(
		"search",
		"grep and find: matches grouped by file",
		"chat-tools-search-tool-card",
		"grep, a symbol across files",
	),
	toolCard(
		"lsp",
		"lsp: references from the language server",
		"chat-tools-lsp-tool-card",
		"References, a handful",
	),
	toolCard(
		"web-search",
		"web_search: the result links",
		"chat-tools-web-search-tool-card",
		"Result with links",
	),
	toolCard(
		"task",
		"task: the subagents a call spawned, with their tokens, cost and run time",
		"chat-tools-task-tool-card",
		"Three agents with tokens, cost and run time",
	),
	toolCard(
		"todo",
		"todo: the phased task list",
		"chat-tools-todo-tool-card",
		"Phases from call args",
	),
	toolCard(
		"wait",
		"wait: the jobs and agents the turn is waiting on",
		"chat-tools-wait-tool-card",
		"Live run of two waits",
	),
];

export const STILLS: readonly StillScene[] = [
	{
		id: "fleet-sidebar",
		shows: "Sidebar: projects, worktrees, running and asleep sessions, usage meters",
		source: { kind: "app", route: SESSION },
		viewport: "desktop",
		clip: { selector: "aside.sidebar" },
		ready: [LOADED, ".sidebar-usage svg"],
	},
	{
		id: "new-workspace-popover",
		shows: "New worktree popover: search this machine's branches or name a new one",
		// No provider profiles: clones are in development, so the README does not show their chips.
		source: {
			kind: "story",
			story: "fleet-sidebar-new-workspace-popover",
			variant: "No provider profiles: branches only",
		},
		viewport: "desktop",
		clip: { selector: ".popover.new-workspace", pad: 16 },
		ready: [".new-workspace-row:not([disabled])"],
	},
	{
		id: "phone-transcript",
		shows: "Phone: the session transcript and composer",
		source: { kind: "app", route: SESSION },
		viewport: "phone",
		ready: ["text=Yes: the wrapper runs", COMPOSER],
	},
	{
		id: "phone-sidebar",
		shows: "Phone: the sidebar drawer over the transcript",
		source: {
			kind: "app",
			route: SESSION,
			steps: [{ click: "button[aria-label='Open roster sidebar']" }],
		},
		viewport: "phone",
		ready: [".sidebar-usage svg"],
	},
	{
		id: "phone-activities",
		shows: "Phone: the activities dock with subagents and jobs",
		source: { kind: "app", route: `${SESSION}/activities` },
		viewport: "phone",
		ready: ["text=FenceCallers", "text=bun run dev"],
	},
	{
		id: "command-palette",
		shows: "Ctrl+K palette: one search over commands, workspaces and settings",
		source: {
			kind: "app",
			route: SESSION,
			steps: [
				{ wait: LOADED },
				{ press: "Control+k" },
				{ fill: PALETTE_INPUT, text: "new" },
				{ wait: "text=New workspace: omp-web" },
			],
		},
		viewport: "desktop",
		ready: [".picker-list"],
	},
	{
		id: "transcript-markdown",
		shows: "Assistant answer: headings, a rendered table, lists, inline code, highlighted fence",
		source: { kind: "story", story: "ui-markdown", variant: "Answer with a table" },
		viewport: "panel",
		clip: VARIANT,
		ready: [".ds-variant-body table", ".ds-variant-body pre"],
	},
	...TOOL_STILLS,
	{
		id: "activities-subagents-jobs",
		shows: "Activities dock: the subagents and the background jobs, with the activity chips",
		source: {
			kind: "app",
			route: `${SESSION}/activities`,
			steps: [{ wait: LOADED }, ...foldSections("daemons", "todos")],
		},
		viewport: "desktop",
		clip: ACTIVITIES_AREA,
		ready: [
			"text=FenceCallers",
			"text=bun run dev",
			"[data-activity-section='daemons'] [aria-expanded='false']",
		],
	},
	{
		id: "activities-daemons-todos",
		shows: "Activities dock: the daemons and the todo checklist, with the activity chips",
		source: {
			kind: "app",
			route: `${SESSION}/activities`,
			steps: [{ wait: LOADED }, ...foldSections("subagents", "jobs")],
		},
		viewport: "desktop",
		clip: ACTIVITIES_AREA,
		ready: [
			"text=vite-dev",
			"text=Wrap fences and mount the button",
			"[data-activity-section='jobs'] [aria-expanded='false']",
		],
	},
	{
		id: "composer-autocomplete",
		shows: "Composer: slash-command autocomplete popup",
		source: {
			kind: "app",
			route: SESSION,
			steps: [{ wait: LOADED }, { click: COMPOSER }, { type: COMPOSER, text: "/" }],
		},
		viewport: "desktop",
		clip: COMPOSER_AREA,
		ready: ["text=Switch the active model"],
	},
	{
		id: "model-presets",
		shows: "Models dialog: presets with their roles",
		source: { kind: "story", story: "models-model-dialog", variant: "Presets, custom roles" },
		viewport: "desktop",
		clip: MODAL,
		ready: [".model-dialog-row-name"],
	},
	{
		id: "settings",
		shows: "Settings sheet: omp's own settings, in the browser",
		source: {
			kind: "app",
			route: SESSION,
			steps: [{ wait: LOADED }, { press: "Control+," }, { wait: "text=Auto-Compact" }],
		},
		viewport: "desktop",
		ready: ["text=Render Mermaid Diagrams"],
	},
	{
		id: "appearance",
		shows: "Appearance sheet: mode, theme, text size, transcript display",
		// The app, not the story: the story seeds two failed theme files that the boot's own theme
		// load then replaces, so the failure list raced in and out; the demo loads every file.
		source: {
			kind: "app",
			route: SESSION,
			steps: [{ wait: LOADED }, { click: "button[aria-label='Appearance']" }],
		},
		viewport: "desktop",
		clip: MODAL,
		ready: ["text=Light & dark theme"],
		until: THEMES_LOADED,
	},
	{
		id: "theme-picker",
		shows: "Theme picker: every theme with its dark and light halves",
		source: { kind: "story", story: "app-theme-picker", variant: "Linked" },
		viewport: "desktop",
		clip: { selector: ".ds-frame-panel", pad: 0 },
		ready: ["text=Tokyo Night"],
		until: THEMES_LOADED,
	},
	{
		id: "extensions",
		shows: "Extensions dialog: the MCP tab with a server's tools",
		source: {
			kind: "app",
			route: SESSION,
			steps: [
				{ wait: LOADED },
				{ press: "Control+k" },
				{ click: ".picker-list >> text=MCP servers" },
				{ wait: "text=secure-filesystem-server" },
			],
		},
		viewport: "desktop",
		ready: ['ul[aria-label="MCP servers"]'],
	},
	{
		id: "sidebar-usage",
		shows: "Sidebar usage meters: rate-limit windows per provider",
		source: { kind: "app", route: SESSION },
		viewport: "desktop",
		clip: { selector: ".sidebar-usage" },
		ready: [LOADED, ".sidebar-usage svg"],
	},
];

/** The same app view rendered in every built-in theme and tiled; one file per scheme (the themes come from `BUILTIN_THEMES`). */
export const THEMES_GRID_ID = "themes-grid";
export const THEMES_GRID_SHOWS = "The app in every built-in theme";

export const HERO_ID = "hero";
/** The same journey on a Google Pixel phone, with touch taps. */
export const HERO_PHONE_ID = "hero-phone";
export const ARCHITECTURE_ID = "architecture";
/** The split form: `omp-web ui` and `omp-web control` as separate processes. */
export const ARCHITECTURE_SPLIT_ID = "architecture-split";
/** One session on a desktop, a tablet and a phone (the multi-device section). */
export const DEVICES_ID = "devices";

/** `still`: lossless WebP of the live page; `video`: animated WebP; `svg`: generated, no browser. */
export type ShotKind = "still" | "video" | "svg";

/** One selectable shot: `<id>-<scheme>.<ext>` is the file it produces in each scheme. */
export interface Shot {
	id: string;
	kind: ShotKind;
	/** One line: what the shot is meant to show (`--list`, the contact sheet). */
	shows: string;
	ext: "webp" | "svg";
}

/** Every shot the script owns, in contact-sheet order. */
export const SHOTS: readonly Shot[] = [
	{
		id: HERO_ID,
		kind: "video",
		shows: "Hero animation: type a prompt with an @ mention, send, watch the turn, open Activities",
		ext: "webp",
	},
	{
		id: HERO_PHONE_ID,
		kind: "video",
		shows:
			"Phone hero animation (Google Pixel 7, touch): sidebar drawer, type and send a prompt, watch the turn, open Activities",
		ext: "webp",
	},
	...STILLS.map((scene): Shot => ({
		id: scene.id,
		kind: "still",
		shows: scene.shows,
		ext: "webp",
	})),
	{ id: THEMES_GRID_ID, kind: "still", shows: THEMES_GRID_SHOWS, ext: "webp" },
	{ id: ARCHITECTURE_ID, kind: "svg", shows: "Architecture diagram (README SVG)", ext: "svg" },
	{
		id: ARCHITECTURE_SPLIT_ID,
		kind: "svg",
		shows: "Split-form architecture: omp-web ui and omp-web control as separate processes",
		ext: "svg",
	},
	{
		id: DEVICES_ID,
		kind: "svg",
		shows: "One session on a desktop, a tablet and a phone (README SVG)",
		ext: "svg",
	},
];

/** Every file the script owns in `docs/screenshots/`. */
export function outputFiles(): string[] {
	return SCHEMES.flatMap((scheme) =>
		SHOTS.map((shot) => `${shot.id}-${scheme}.${shot.ext}`),
	).sort();
}

export { COMPOSER, LOADED, SESSION };
