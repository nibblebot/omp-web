/**
 * Devices illustration for the README: one session open on a desktop, a tablet
 * and a phone. Same rules as the architecture diagram (`architecture-svg.ts`):
 * a standalone SVG with no scripts, external references or webfonts, a
 * transparent background, and fills on every shape so it reads on any page
 * color of the matching scheme.
 */
import type { ArchitecturePalette } from "./architecture-svg";

const SANS = `"Noto Sans", system-ui, sans-serif`;

const WIDTH = 532;
const HEIGHT = 236;
/** Every device stands on this line; labels sit under it. */
const BASELINE = 204;
const LABEL_Y = 228;

/** One decimal place keeps the markup short and the output stable. */
function n(value: number): number {
	return Math.round(value * 10) / 10;
}

/** Lines of one section, indented to sit inside `<svg>`. */
function block(...lines: string[]): string {
	return lines.join("\n\t");
}

interface Screen {
	x: number;
	y: number;
	width: number;
	height: number;
	/** Draw the session sidebar (wide screens only). */
	sidebar: boolean;
}

/** The same session on every screen: sidebar, a prompt, the answer, a tool card, the composer. */
function sessionScreen(palette: ArchitecturePalette, screen: Screen): string[] {
	const { surface, panel, border, borderStrong, accent } = palette;
	const { x, y, width, height, sidebar } = screen;
	const pad = Math.max(5, width * 0.06);
	const line = Math.max(3.5, height * 0.04);
	const lines: string[] = [
		`<rect x="${n(x)}" y="${n(y)}" width="${n(width)}" height="${n(height)}" rx="4" fill="${surface}" stroke="${border}" stroke-width="1"/>`,
	];
	let left = x + pad;
	if (sidebar) {
		const sidebarW = width * 0.22;
		lines.push(
			`<rect x="${n(left)}" y="${n(y + pad)}" width="${n(sidebarW)}" height="${n(height - 2 * pad)}" rx="3" fill="${panel}"/>`,
		);
		for (let row = 0; row < 4; row += 1) {
			const rowY = y + pad * 1.8 + row * line * 2.6;
			lines.push(
				`<circle cx="${n(left + pad * 0.9)}" cy="${n(rowY + line / 2)}" r="${n(line * 0.45)}" fill="${row === 0 ? accent : borderStrong}"/>`,
				`<rect x="${n(left + pad * 1.7)}" y="${n(rowY)}" width="${n(sidebarW - pad * 2.4)}" height="${n(line)}" rx="${n(line / 2)}" fill="${borderStrong}" opacity="${row === 0 ? 0.6 : 0.35}"/>`,
			);
		}
		left += sidebarW + pad;
	}
	const right = x + width - pad;
	const content = right - left;
	const composerH = line * 3;
	const composerY = y + height - pad - composerH;
	const step = line * 2;
	let top = y + pad;
	// The prompt, right-aligned in the accent tint.
	lines.push(
		`<rect x="${n(left + content * 0.42)}" y="${n(top)}" width="${n(content * 0.58)}" height="${n(line * 2.4)}" rx="${n(line)}" fill="${accent}" fill-opacity="0.28"/>`,
	);
	top += line * 2.4 + step;
	// The answer streaming in.
	for (const fraction of [0.92, 0.78, 0.86]) {
		lines.push(
			`<rect x="${n(left)}" y="${n(top)}" width="${n(content * fraction)}" height="${n(line)}" rx="${n(line / 2)}" fill="${borderStrong}" opacity="0.4"/>`,
		);
		top += step;
	}
	// A tool card, when there is room above the composer.
	const cardH = line * 3.4;
	if (top + cardH + step <= composerY) {
		lines.push(
			`<rect x="${n(left)}" y="${n(top)}" width="${n(content)}" height="${n(cardH)}" rx="3" fill="${panel}" stroke="${borderStrong}" stroke-width="1" stroke-opacity="0.6"/>`,
			`<rect x="${n(left + pad * 0.8)}" y="${n(top + (cardH - line) / 2)}" width="${n(content * 0.4)}" height="${n(line)}" rx="${n(line / 2)}" fill="${accent}" opacity="0.7"/>`,
		);
	}
	lines.push(
		`<rect x="${n(left)}" y="${n(composerY)}" width="${n(content)}" height="${n(composerH)}" rx="${n(line)}" fill="${panel}" stroke="${borderStrong}" stroke-width="1"/>`,
		`<circle cx="${n(right - composerH / 2)}" cy="${n(composerY + composerH / 2)}" r="${n(line * 0.7)}" fill="${accent}"/>`,
	);
	return lines;
}

function label(palette: ArchitecturePalette, centerX: number, text: string): string {
	return `<text x="${n(centerX)}" y="${LABEL_Y}" text-anchor="middle" font-size="15" font-weight="600" fill="${palette.muted}">${text}</text>`;
}

function desktop(palette: ArchitecturePalette): string {
	const { panel, borderStrong } = palette;
	const x = 4;
	const width = 264;
	const y = 18;
	const height = 162;
	const centerX = x + width / 2;
	return block(
		`<!-- Desktop -->`,
		`<rect x="${n(centerX - 16)}" y="${y + height}" width="32" height="${BASELINE - 6 - y - height}" fill="${panel}" stroke="${borderStrong}" stroke-width="1.5"/>`,
		`<rect x="${n(centerX - 44)}" y="${BASELINE - 6}" width="88" height="6" rx="3" fill="${panel}" stroke="${borderStrong}" stroke-width="1.5"/>`,
		`<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="10" fill="${panel}" stroke="${borderStrong}" stroke-width="1.5"/>`,
		...sessionScreen(palette, {
			x: x + 9,
			y: y + 9,
			width: width - 18,
			height: height - 18,
			sidebar: true,
		}),
		label(palette, centerX, "Desktop"),
	);
}

function tablet(palette: ArchitecturePalette): string {
	const { panel, borderStrong } = palette;
	const x = 298;
	const width = 124;
	const height = 160;
	const y = BASELINE - height;
	return block(
		`<!-- Tablet -->`,
		`<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="12" fill="${panel}" stroke="${borderStrong}" stroke-width="1.5"/>`,
		...sessionScreen(palette, {
			x: x + 8,
			y: y + 10,
			width: width - 16,
			height: height - 20,
			sidebar: false,
		}),
		label(palette, x + width / 2, "Tablet"),
	);
}

function phone(palette: ArchitecturePalette): string {
	const { panel, borderStrong } = palette;
	const x = 452;
	const width = 76;
	const height = 132;
	const y = BASELINE - height;
	const centerX = x + width / 2;
	return block(
		`<!-- Phone -->`,
		`<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="12" fill="${panel}" stroke="${borderStrong}" stroke-width="1.5"/>`,
		...sessionScreen(palette, {
			x: x + 5,
			y: y + 12,
			width: width - 10,
			height: height - 20,
			sidebar: false,
		}),
		`<rect x="${n(centerX - 9)}" y="${y + 5}" width="18" height="3" rx="1.5" fill="${borderStrong}"/>`,
		label(palette, centerX, "Phone"),
	);
}

/** The illustration as a complete SVG document string (trailing newline included). */
export function renderDevicesSvg(palette: ArchitecturePalette): string {
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" width="${WIDTH}" height="${HEIGHT}" role="img" aria-labelledby="devices-title devices-desc" font-family='${SANS}'>
	<title id="devices-title">One session on every device</title>
	<desc id="devices-desc">The same omp-web session open on a desktop, a tablet and a phone.</desc>

	${[desktop(palette), tablet(palette), phone(palette)].join("\n\n\t")}
</svg>
`;
}
