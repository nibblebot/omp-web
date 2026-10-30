/**
 * Architecture diagram for the README: browser, omp-web, and the omp sessions
 * that dial out to it. Rendered as a standalone SVG (GitHub shows it through
 * `<img>`, so no scripts, no external references, no webfonts) with a
 * transparent background; cards bring their own fills so one file reads on any
 * page color of the matching scheme.
 */
import type { ThemeVariant } from "#lib/themes/types";

/** Colors the diagram draws with; each is a `#rgb`, `#rrggbb` or `#rrggbbaa` hex. */
export interface ArchitecturePalette {
	/** Card fill (the theme's page background). */
	surface: string;
	/** Fill of shapes drawn on a card (window and phone glyphs). */
	panel: string;
	/** Titles and body text. */
	text: string;
	/** Captions, arrows and arrow labels. */
	muted: string;
	/** Card outlines. */
	border: string;
	/** Glyph outlines, a step stronger than `border`. */
	borderStrong: string;
	/** The omp-web card and its bullets. */
	accent: string;
}

/** Palette for one resolved theme variant; the tokens must be hex colors (every built-in's are). */
export function architecturePaletteFromTheme(variant: ThemeVariant): ArchitecturePalette {
	const { tokens } = variant;
	return {
		surface: tokens.bg,
		panel: tokens.panel,
		text: tokens.text,
		muted: tokens.muted,
		border: tokens.border,
		borderStrong: tokens["border-strong"],
		accent: tokens.accent,
	};
}

const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

const SANS = `"Noto Sans", system-ui, sans-serif`;
const MONO = `"Fira Code", ui-monospace, "DejaVu Sans Mono", monospace`;

const WIDTH = 940;
const HEIGHT = 344;
const CENTER_Y = 190;

const BROWSER_X = 4;
const BROWSER_W = 190;
const SERVER_X = 344;
const SERVER_W = 190;
const SESSIONS_X = 704;
const SESSIONS_W = 232;
const TALL_Y = 90;
const TALL_H = 200;

const SESSION_H = 88;
const SESSION_GAP = 14;
const SESSION_TOP = 44;
const SESSIONS = ["omp-web/main", "omp-web/fix-sidebar", "api/feature-x"] as const;

/** Arrow tips stop short of the card edge so the head does not touch the stroke. */
const TIP_GAP = 8;

// Split form: wider, with the server split into the UI process and the control plane.
const SPLIT_CARD_W = 210;
const SPLIT_TITLE_SIZE = 20;
const SPLIT_UI_X = 370;
const SPLIT_CONTROL_X = 684;
/** Dashed "one host" outline around both processes. */
const SPLIT_HOST_PAD = 18;
const SPLIT_HOST_Y = 62;
const SPLIT_HOST_H = 262;
const SPLIT_SESSIONS_X = 1100;
const SPLIT_WIDTH = SPLIT_SESSIONS_X + SESSIONS_W + BROWSER_X;

function assertColor(name: string, value: string): void {
	if (!HEX_COLOR.test(value))
		throw new Error(`architecture palette ${name}: not a hex color: ${value}`);
}

function assertPalette(palette: ArchitecturePalette): void {
	for (const [name, value] of Object.entries(palette)) assertColor(name, value);
}

/** Lines of one section, indented to sit inside `<svg>`. */
function block(...lines: string[]): string {
	return lines.join("\n\t");
}

/** The SVG document around `sections`, which are separated by a blank line. */
function svgDocument(
	palette: ArchitecturePalette,
	width: number,
	height: number,
	desc: string,
	sections: string[],
): string {
	const { muted } = palette;
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-labelledby="arch-title arch-desc" font-family='${SANS}'>
	<title id="arch-title">omp-web architecture</title>
	<desc id="arch-desc">${desc}</desc>
	<defs>
		<marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="11" markerHeight="11" orient="auto-start-reverse" markerUnits="userSpaceOnUse">
			<path d="M1 1.5L8.5 5L1 8.5z" fill="${muted}" stroke="${muted}" stroke-width="1" stroke-linejoin="round"/>
		</marker>
	</defs>

	${sections.join("\n\n\t")}
</svg>
`;
}

/** Uppercase caption over each column, at the column's left edge. */
function columnHeads(
	palette: ArchitecturePalette,
	heads: ReadonlyArray<readonly [number, string]>,
): string {
	return block(
		`<g font-size="13.5" font-weight="600" letter-spacing="0.4" fill="${palette.muted}">`,
		...heads.map(([x, label]) => `\t<text x="${x}" y="24">${label}</text>`),
		`</g>`,
	);
}

/** Plain outlined card: the theme's page color with a border. */
function card(
	palette: ArchitecturePalette,
	x: number,
	y: number,
	width: number,
	height: number,
	radius: number,
): string {
	return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${radius}" fill="${palette.surface}" stroke="${palette.border}" stroke-width="1.5"/>`;
}

/** The browser card: desktop window and phone glyphs, name and caption. */
function browserCard(palette: ArchitecturePalette, x: number): string {
	const { panel, text, muted, borderStrong } = palette;
	const centerX = x + BROWSER_W / 2;
	return block(
		`<!-- Browser -->`,
		card(palette, x, TALL_Y, BROWSER_W, TALL_H, 14),
		`<g stroke="${borderStrong}" stroke-width="1.5" fill="${panel}">`,
		`\t<rect x="${x + 16}" y="114" width="112" height="72" rx="7"/>`,
		`\t<rect x="${x + 142}" y="106" width="30" height="80" rx="7"/>`,
		`</g>`,
		`<g fill="${borderStrong}" stroke="none">`,
		`\t<circle cx="${x + 26}" cy="124" r="2.4"/>`,
		`\t<circle cx="${x + 34}" cy="124" r="2.4"/>`,
		`\t<circle cx="${x + 42}" cy="124" r="2.4"/>`,
		`\t<rect x="${x + 24}" y="136" width="22" height="42" rx="3" opacity="0.35"/>`,
		`\t<rect x="${x + 54}" y="138" width="62" height="6" rx="3" opacity="0.35"/>`,
		`\t<rect x="${x + 54}" y="152" width="48" height="6" rx="3" opacity="0.35"/>`,
		`\t<rect x="${x + 54}" y="166" width="56" height="6" rx="3" opacity="0.35"/>`,
		`\t<rect x="${x + 149}" y="114" width="16" height="5" rx="2.5" opacity="0.6"/>`,
		`\t<rect x="${x + 149}" y="128" width="16" height="6" rx="3" opacity="0.35"/>`,
		`\t<rect x="${x + 149}" y="142" width="16" height="6" rx="3" opacity="0.35"/>`,
		`\t<rect x="${x + 149}" y="156" width="16" height="6" rx="3" opacity="0.35"/>`,
		`</g>`,
		`<text x="${centerX}" y="236" text-anchor="middle" font-size="22" font-weight="700" fill="${text}">Browser</text>`,
		`<text x="${centerX}" y="262" text-anchor="middle" font-size="14.5" fill="${muted}">desktop or phone</text>`,
	);
}

interface AccentCardOptions {
	x: number;
	width: number;
	title: string;
	/** Title in the monospace stack (a command) instead of the sans stack. */
	mono: boolean;
	titleSize: number;
	titleY: number;
	/** Muted line under the title. */
	caption?: string;
	bullets: readonly string[];
	firstBulletY: number;
}

/** A tinted card in the accent color: title, optional caption, bulleted capabilities. */
function accentCard(palette: ArchitecturePalette, options: AccentCardOptions): string {
	const { text, muted, accent } = palette;
	const { x, width, title, mono, titleSize, titleY, caption, bullets, firstBulletY } = options;
	const centerX = x + width / 2;
	const family = mono ? ` font-family='${MONO}'` : "";
	return block(
		`<rect x="${x}" y="${TALL_Y}" width="${width}" height="${TALL_H}" rx="14" fill="${accent}" fill-opacity="0.14" stroke="${accent}" stroke-width="2.5"/>`,
		`<text x="${centerX}" y="${titleY}" text-anchor="middle"${family} font-size="${titleSize}" font-weight="700" fill="${accent}">${title}</text>`,
		...(caption === undefined
			? []
			: [
					`<text x="${centerX}" y="${titleY + 24}" text-anchor="middle" font-family='${MONO}' font-size="14.5" fill="${muted}">${caption}</text>`,
				]),
		`<g font-size="16" fill="${text}">`,
		...bullets.flatMap((bullet, i) => [
			`\t<circle cx="${x + 30}" cy="${firstBulletY + i * 30}" r="3.5" fill="${accent}"/>`,
			`\t<text x="${x + 44}" y="${firstBulletY + 5 + i * 30}">${bullet}</text>`,
		]),
		`</g>`,
	);
}

/** A straight horizontal line at `CENTER_Y` between two x positions; arrowheads at the ends named by `heads`. */
function arrow(
	palette: ArchitecturePalette,
	from: number,
	to: number,
	heads: "end" | "both",
): string {
	const markers =
		heads === "both"
			? ` marker-start="url(#arrow)" marker-end="url(#arrow)"`
			: ` marker-end="url(#arrow)"`;
	return `<path d="M${from} ${CENTER_Y}H${to}" fill="none" stroke="${palette.muted}" stroke-width="2" stroke-linecap="round"${markers}/>`;
}

/** Label centered at `x`, just above the arrow line. */
function arrowLabel(palette: ArchitecturePalette, x: number, label: string): string {
	return `<text x="${x}" y="${CENTER_Y - 12}" text-anchor="middle" font-size="14.5" fill="${palette.muted}">${label}</text>`;
}

/**
 * The three session cards with the arrows that merge into one spine and run to
 * `tip` (the control process's right edge plus the arrow gap).
 */
function sessionStack(
	palette: ArchitecturePalette,
	x: number,
	comment: string,
	tip: number,
): string {
	const { text, muted } = palette;
	const spineX = x - 22;
	const centers = SESSIONS.map(
		(_, i) => SESSION_TOP + i * (SESSION_H + SESSION_GAP) + SESSION_H / 2,
	);
	const cards = SESSIONS.map((name, i) => {
		const top = SESSION_TOP + i * (SESSION_H + SESSION_GAP);
		return `
	${card(palette, x, top, SESSIONS_W, SESSION_H, 12)}
	<text x="${x + 16}" y="${top + 36}" font-family='${MONO}' font-size="15" font-weight="600" fill="${text}">${name}</text>
	<text x="${x + 16}" y="${top + 62}" font-size="13.5" fill="${muted}">omp SDK · .jsonl transcript</text>
	<path d="M${x} ${centers[i]}H${spineX}" fill="none" stroke="${muted}" stroke-width="2" stroke-linecap="round"/>`;
	}).join("");
	return `<!-- ${comment} -->${cards}
	<path d="M${spineX} ${centers[0]}V${centers[centers.length - 1]}" fill="none" stroke="${muted}" stroke-width="2" stroke-linecap="round"/>
	${arrow(palette, spineX, tip, "end")}
	${arrowLabel(palette, (tip + spineX) / 2, "sessions dial out")}`;
}

/** The diagram as a complete SVG document string (trailing newline included). */
export function renderArchitectureSvg(palette: ArchitecturePalette): string {
	assertPalette(palette);
	const browserRight = BROWSER_X + BROWSER_W;
	const serverRight = SERVER_X + SERVER_W;
	return svgDocument(
		palette,
		WIDTH,
		HEIGHT,
		"A browser on a desktop or phone talks to omp-web over one WebSocket. omp sessions, one per worktree, dial out to omp-web.",
		[
			columnHeads(palette, [
				[BROWSER_X, "ANY DEVICE"],
				[SERVER_X, "ONE SERVER"],
				[SESSIONS_X, "ONE PER WORKTREE"],
			]),
			browserCard(palette, BROWSER_X),
			block(
				"<!-- Browser to omp-web: one WebSocket, both directions -->",
				arrow(palette, browserRight + TIP_GAP, SERVER_X - TIP_GAP, "both"),
				arrowLabel(palette, (browserRight + SERVER_X) / 2, "one WebSocket"),
			),
			block(
				"<!-- omp-web -->",
				accentCard(palette, {
					x: SERVER_X,
					width: SERVER_W,
					title: "omp-web",
					mono: false,
					titleSize: 26,
					titleY: 142,
					bullets: ["Projects", "Lifecycle", "Serves the UI"],
					firstBulletY: 179,
				}),
			),
			sessionStack(palette, SESSIONS_X, "Sessions dial out to omp-web", serverRight + TIP_GAP),
		],
	);
}

/**
 * The split form (`omp-web ui` and `omp-web control` as two processes on one
 * host) as a complete SVG document string, in the combined diagram's visual
 * language.
 */
export function renderSplitArchitectureSvg(palette: ArchitecturePalette): string {
	assertPalette(palette);
	const browserRight = BROWSER_X + BROWSER_W;
	const uiRight = SPLIT_UI_X + SPLIT_CARD_W;
	const controlRight = SPLIT_CONTROL_X + SPLIT_CARD_W;
	const hostX = SPLIT_UI_X - SPLIT_HOST_PAD;
	const hostW = controlRight + SPLIT_HOST_PAD - hostX;
	return svgDocument(
		palette,
		SPLIT_WIDTH,
		HEIGHT,
		"A browser on a desktop or phone talks over one WebSocket to omp-web ui, which serves the web UI. omp-web ui reaches omp-web control over loopback on the same host. omp sessions, one per worktree, dial out to omp-web control.",
		[
			columnHeads(palette, [
				[BROWSER_X, "ANY DEVICE"],
				[SPLIT_UI_X, "UI PROCESS"],
				[SPLIT_CONTROL_X, "CONTROL PLANE"],
				[SPLIT_SESSIONS_X, "ONE PER WORKTREE"],
			]),
			block(
				"<!-- One host: both processes run on the same machine -->",
				`<rect x="${hostX}" y="${SPLIT_HOST_Y}" width="${hostW}" height="${SPLIT_HOST_H}" rx="20" fill="none" stroke="${palette.borderStrong}" stroke-width="1.5" stroke-dasharray="7 6"/>`,
				`<text x="${hostX + hostW / 2}" y="${SPLIT_HOST_Y + SPLIT_HOST_H - 12}" text-anchor="middle" font-size="13.5" font-weight="600" letter-spacing="0.4" fill="${palette.muted}">ONE HOST</text>`,
			),
			browserCard(palette, BROWSER_X),
			block(
				"<!-- Browser to omp-web ui: one WebSocket, both directions -->",
				arrow(palette, browserRight + TIP_GAP, SPLIT_UI_X - TIP_GAP, "both"),
				arrowLabel(palette, (browserRight + SPLIT_UI_X) / 2, "one WebSocket"),
			),
			block(
				"<!-- omp-web ui -->",
				accentCard(palette, {
					x: SPLIT_UI_X,
					width: SPLIT_CARD_W,
					title: "omp-web ui",
					mono: true,
					titleSize: SPLIT_TITLE_SIZE,
					titleY: 146,
					caption: "default port 4723",
					bullets: ["Serves the UI", "Proxies API and /ws"],
					firstBulletY: 212,
				}),
			),
			block(
				"<!-- omp-web ui to omp-web control, loopback -->",
				arrow(palette, uiRight + TIP_GAP, SPLIT_CONTROL_X - TIP_GAP, "both"),
				arrowLabel(palette, (uiRight + SPLIT_CONTROL_X) / 2, "loopback"),
			),
			block(
				"<!-- omp-web control -->",
				accentCard(palette, {
					x: SPLIT_CONTROL_X,
					width: SPLIT_CARD_W,
					title: "omp-web control",
					mono: true,
					titleSize: SPLIT_TITLE_SIZE,
					titleY: 146,
					caption: "default port 4722",
					bullets: ["Projects", "Lifecycle"],
					firstBulletY: 212,
				}),
			),
			sessionStack(
				palette,
				SPLIT_SESSIONS_X,
				"Sessions dial out to omp-web control",
				controlRight + TIP_GAP,
			),
		],
	);
}
