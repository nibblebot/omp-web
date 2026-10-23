/**
 * Design-token regression test for the merged transcripts section.
 *
 * Reads the tx section of src/tx/tx.css (from the tx banner comment to EOF)
 * and the fleet palettes from src/styles/tokens.css, and enforces:
 * - every `var(--tx-...)` referenced inside the section is defined there
 *   (the rename .badge→.tx-badge, --bg→--tx-bg, etc. must not leave dangles)
 * - --tx-text-faint resolves to a WCAG AA 4.5:1 pair on both --tx-bg and
 *   --tx-bg-selected, in the default (dark) palette and in fleet's canonical
 *   light palette (fleet's light theme re-skins tx via the var() chains)
 * - dark-theme hierarchy: faint stays less prominent than dim
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const tokensCss = readFileSync(join(import.meta.dir, "..", "..", "styles", "tokens.css"), "utf8");
const txCss = readFileSync(join(import.meta.dir, "..", "..", "tx", "tx.css"), "utf8");

const TX_BANNER = "/* ── tx: transcripts view ── */";
const bannerAt = txCss.indexOf(TX_BANNER);
if (bannerAt === -1) throw new Error("tx section banner not found in apps/web/tx/tx.css");
const txSection = txCss.slice(bannerAt);

/** Fleet palette block for a theme selector (default dark = `:root`). */
function parseFleetTokens(selector: string): Record<string, string> {
	const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const block = tokensCss.match(new RegExp(`${esc}\\s*\\{([^}]*)\\}`));
	if (!block) throw new Error(`${selector} token block not found in apps/web/styles/tokens.css`);
	const tokens: Record<string, string> = {};
	for (const m of block[1]!.matchAll(/--([\w-]+):\s*([^;]+);/g)) {
		tokens[m[1]!] = m[2]!.trim();
	}
	return tokens;
}

/** All --tx-* definitions inside the tx section (light override wins). */
function parseTxTokens(): Record<string, string> {
	const tokens: Record<string, string> = {};
	for (const m of txSection.matchAll(/(--tx-[\w-]+):\s*([^;]+);/g)) {
		tokens[m[1]!] = m[2]!.trim();
	}
	return tokens;
}

const txTokens = parseTxTokens();
const dark = parseFleetTokens(":root");
const light = parseFleetTokens(':root[data-theme="light"]');

/** Resolve a token value through var() chains and srgb color-mix. */
function resolve(name: string, tx: Record<string, string>, fleet: Record<string, string>): string {
	const bare = name.replace(/^--/, "");
	const raw = tx[bare] ?? tx[`--${bare}`] ?? fleet[bare] ?? fleet[`--${bare}`];
	if (!raw) throw new Error(`no definition for --${bare}`);
	const varM = raw.match(/^var\(--([\w-]+)\)$/);
	if (varM) return resolve(varM[1]!, tx, fleet);
	const mixM = raw.match(
		/^color-mix\(in srgb,\s*var\(--([\w-]+)\)\s+([\d.]+)%,\s*var\(--([\w-]+)\)\s*\)$/,
	);
	if (mixM) {
		const a = resolve(mixM[1]!, tx, fleet);
		const b = resolve(mixM[3]!, tx, fleet);
		return mixHex(a, b, parseFloat(mixM[2]!));
	}
	return raw;
}

function hexToRgb(hex: string): [number, number, number] {
	const h = hex.replace("#", "");
	if (!/^[0-9a-fA-F]{6}$/.test(h)) throw new Error(`not a 6-digit hex color: ${hex}`);
	return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function mixHex(aHex: string, bHex: string, pctA: number): string {
	const [ar, ag, ab] = hexToRgb(aHex);
	const [br, bg, bb] = hexToRgb(bHex);
	const mix = (a: number, b: number) => Math.round(a * (pctA / 100) + b * (1 - pctA / 100));
	return `#${[mix(ar, br), mix(ag, bg), mix(ab, bb)].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

function channel(c: number): number {
	const v = c / 255;
	return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function luminance(hex: string): number {
	const [r, g, b] = hexToRgb(hex);
	return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: string, b: string): number {
	const [la, lb] = [luminance(a), luminance(b)];
	const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
	return (hi + 0.05) / (lo + 0.05);
}

describe("tx section token integrity", () => {
	test("every var(--tx-...) reference inside the section is defined there", () => {
		const refs = new Set<string>();
		for (const m of txSection.matchAll(/var\((--tx-[\w-]+)\)/g)) refs.add(m[1]!);
		expect(refs.size).toBeGreaterThan(10);
		for (const name of refs) {
			expect(txTokens[name], `missing definition for ${name}`).toBeDefined();
		}
	});

	test("font stacks stay literal tx fonts", () => {
		expect(txTokens["--tx-mono"]).toMatch(/^"Noto Sans Mono", ui-monospace/);
		expect(txTokens["--tx-sans"]).toMatch(/^"Noto Sans", system-ui/);
	});

	test("light override block covers every fleet light theme selector", () => {
		const lightBlock = txSection.slice(txSection.indexOf("Light palettes"));
		const block = lightBlock.slice(0, lightBlock.indexOf("}") + 1);
		expect(block).toContain(':root[data-theme="light"]');
		expect(block).toContain(':root[data-theme="catppuccin-latte"]');
		expect(block).toContain(':root[data-theme="omp-light"]');
		expect(block).toContain("--tx-banner-code-bg: rgba(255, 255, 255, 0.35)");
	});
});

describe("resolved tx contrast", () => {
	const faint = (fleet: Record<string, string>) => resolve("tx-text-faint", txTokens, fleet);
	const bg = (fleet: Record<string, string>) => resolve("tx-bg", txTokens, fleet);
	const bgSelected = (fleet: Record<string, string>) => resolve("tx-bg-selected", txTokens, fleet);
	const dim = (fleet: Record<string, string>) => resolve("tx-text-dim", txTokens, fleet);

	for (const [name, fleet] of [
		["dark", dark],
		["light", light],
	] as const) {
		describe(name, () => {
			test("--tx-text-faint resolves to a 6-digit hex color", () => {
				const f = faint(fleet);
				expect(f).toMatch(/^#[0-9a-fA-F]{6}$/);
			});

			test("--tx-text-faint reaches 4.5:1 on the main background", () => {
				expect(contrast(faint(fleet), bg(fleet))).toBeGreaterThanOrEqual(4.5);
			});

			test("--tx-text-faint reaches 4.5:1 on the selected-row background", () => {
				expect(contrast(faint(fleet), bgSelected(fleet))).toBeGreaterThanOrEqual(4.5);
			});
		});
	}

	test("dark theme: faint stays less prominent than dim", () => {
		// On a dark background less prominent = darker.
		const onDarkBg = luminance(bg(dark)) < 0.5;
		expect(onDarkBg).toBe(true);
		expect(luminance(faint(dark))).toBeLessThan(luminance(dim(dark)));
	});
});

/** oklch(L% C h) literal (no alpha) to a 6-digit sRGB hex. */
function oklchToHex(value: string): string {
	const m = value.match(/^oklch\(\s*([\d.]+)%\s+([\d.]+)\s+([\d.]+)\s*\)$/);
	if (!m) throw new Error(`not an oklch() color: ${value}`);
	const L = parseFloat(m[1]!) / 100;
	const C = parseFloat(m[2]!);
	const h = (parseFloat(m[3]!) * Math.PI) / 180;
	const a = C * Math.cos(h);
	const b = C * Math.sin(h);
	const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
	const mm = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
	const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
	const lin = [
		4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * s,
		-1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * s,
		-0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * s,
	];
	const enc = (c: number) => {
		const v = Math.min(1, Math.max(0, c));
		const g = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
		return Math.round(g * 255)
			.toString(16)
			.padStart(2, "0");
	};
	return `#${lin.map(enc).join("")}`;
}

/** Hex or oklch() token value as a 6-digit hex. */
function toHex(value: string): string {
	return value.startsWith("oklch(") ? oklchToHex(value) : value;
}

const THEMES = [
	":root",
	':root[data-theme="light"]',
	':root[data-theme="catppuccin-mocha"]',
	':root[data-theme="catppuccin-latte"]',
	':root[data-theme="omp-dark"]',
	':root[data-theme="omp-light"]',
] as const;

const CATEGORY_TOKENS = [
	"tool-shell",
	"tool-read",
	"tool-write",
	"tool-search",
	"tool-agents",
	"tool-other",
] as const;
const SYNTAX_TOKENS = [
	"syn-keyword",
	"syn-string",
	"syn-number",
	"syn-comment",
	"syn-title",
	"syn-attr",
	"syn-meta",
] as const;

/** Hue of a hex color in degrees, or null when achromatic. */
function hue(hex: string): number | null {
	const [r, g, b] = hexToRgb(hex).map((v) => v / 255) as [number, number, number];
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const d = max - min;
	if (d < 0.06) return null;
	let h: number;
	if (max === r) h = ((g - b) / d) % 6;
	else if (max === g) h = (b - r) / d + 2;
	else h = (r - g) / d + 4;
	return (h * 60 + 360) % 360;
}

describe("tool category and syntax tokens", () => {
	for (const selector of THEMES) {
		describe(selector, () => {
			const fleet = parseFleetTokens(selector);
			const panel = toHex(fleet["panel"]!);
			const deep = toHex(fleet["bg-deep"]!);
			for (const name of [...CATEGORY_TOKENS, ...SYNTAX_TOKENS]) {
				test(`--${name} is defined and reaches 4.5:1 on --panel and --bg-deep`, () => {
					const value = fleet[name];
					expect(value, `--${name} missing in ${selector}`).toBeDefined();
					const color = toHex(value!);
					expect(contrast(color, panel)).toBeGreaterThanOrEqual(4.5);
					expect(contrast(color, deep)).toBeGreaterThanOrEqual(4.5);
				});
			}
			for (const name of CATEGORY_TOKENS) {
				test(`--${name} avoids red and green hues`, () => {
					const h = hue(toHex(fleet[name]!));
					if (h === null) return;
					// Red wraps around 0 (340-20), green spans 75-170 (HSL degrees).
					const redish = h >= 340 || h <= 20;
					const greenish = h >= 75 && h <= 170;
					expect(redish || greenish, `hue ${h.toFixed(0)}`).toBe(false);
				});
			}
		});
	}
});

/** A translucent diff background token composited over `base`, as a 6-digit hex. */
function overBase(value: string, base: string): string {
	const rgba = value.match(/^rgba\(\s*(\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\s*\)$/);
	if (rgba) {
		const hex = [rgba[1], rgba[2], rgba[3]]
			.map((v) => Number(v).toString(16).padStart(2, "0"))
			.join("");
		return mixHex(`#${hex}`, base, parseFloat(rgba[4]!) * 100);
	}
	const ok = value.match(/^(oklch\([^/]+?)\s*\/\s*([\d.]+)\s*\)$/);
	if (!ok) throw new Error(`not an rgba()/oklch() color with alpha: ${value}`);
	return mixHex(oklchToHex(`${ok[1]})`), base, parseFloat(ok[2]!) * 100);
}

describe("syntax tokens on diff row backgrounds", () => {
	for (const selector of THEMES) {
		describe(selector, () => {
			const fleet = parseFleetTokens(selector);
			const panel = toHex(fleet["panel"]!);
			for (const kind of ["add", "del"] as const) {
				const bg = overBase(fleet[`diff-${kind}-bg`]!, panel);
				for (const name of [...SYNTAX_TOKENS, "text"]) {
					test(`--${name} reaches 4.5:1 on --diff-${kind}-bg over --panel`, () => {
						expect(contrast(toHex(fleet[name]!), bg)).toBeGreaterThanOrEqual(4.5);
					});
				}
			}
		});
	}
});
