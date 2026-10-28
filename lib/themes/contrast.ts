/**
 * Contrast solving (used to derive `tool-*`, `syn-*` and a few text tokens) and the
 * contrast report (`ThemeContrastWarning`s on a resolved variant). Browser-safe.
 */
import { composite, contrastRatio, fromOklch, hslHue, parseColor, toOklch } from "./color";
import type { Rgb } from "./color";
import type { ThemeContrastWarning, ThemeScheme, ThemeToken } from "./types";

/** WCAG AA for normal text. */
export const MIN_CONTRAST = 4.5;

export const TOOL_TOKENS = [
	"tool-shell",
	"tool-read",
	"tool-write",
	"tool-search",
	"tool-agents",
	"tool-other",
] as const satisfies readonly ThemeToken[];

export const SYNTAX_TOKENS = [
	"syn-keyword",
	"syn-string",
	"syn-number",
	"syn-comment",
	"syn-title",
	"syn-attr",
	"syn-meta",
] as const satisfies readonly ThemeToken[];

/**
 * Tokens the UI sets as running text on the page and panel surfaces: body and secondary
 * text, plus the accent and status colors (links, badges, notices, usage numbers).
 */
export const TEXT_TOKENS = [
	"text",
	"muted",
	"muted-2",
	"muted-3",
	"accent",
	"success",
	"warning",
	"error",
] as const satisfies readonly ThemeToken[];

const SCAN_STEPS = 200;

function worstContrast(color: Rgb, backgrounds: readonly Rgb[]): number {
	let worst = Number.POSITIVE_INFINITY;
	for (const bg of backgrounds) worst = Math.min(worst, contrastRatio(color, bg));
	return worst;
}

/**
 * The color with this hue and chroma whose lightness is closest to `seedL` while
 * reaching `min` contrast on every background. When none reaches it, the color with
 * the best worst-case contrast (the report then flags it).
 */
export function solveLightness(
	hue: number,
	chroma: number,
	seedL: number,
	backgrounds: readonly Rgb[],
	min = MIN_CONTRAST,
): Rgb {
	let passing: Rgb | null = null;
	let passingDistance = Number.POSITIVE_INFINITY;
	let best = fromOklch(seedL, chroma, hue);
	let bestScore = Number.NEGATIVE_INFINITY;
	for (let i = 0; i <= SCAN_STEPS; i++) {
		const l = i / SCAN_STEPS;
		const color = fromOklch(l, chroma, hue);
		const score = worstContrast(color, backgrounds);
		if (score > bestScore) {
			bestScore = score;
			best = color;
		}
		const distance = Math.abs(l - seedL);
		if (score >= min && distance < passingDistance) {
			passing = color;
			passingDistance = distance;
		}
	}
	return passing ?? best;
}

/** `color` unchanged when it already reaches `min` on every background, else the nearest-lightness fix keeping hue and chroma. */
export function adjustLightness(color: Rgb, backgrounds: readonly Rgb[], min = MIN_CONTRAST): Rgb {
	if (worstContrast(color, backgrounds) >= min) return color;
	const lch = toOklch(color);
	return solveLightness(lch.h, lch.c, lch.l, backgrounds, min);
}

/** The opaque surfaces text-like tokens are measured against. */
export interface Surfaces {
	bg: Rgb;
	panel: Rgb;
	deep: Rgb;
	/** `diff-add-bg` / `diff-del-bg` composited over `panel`. */
	diffAdd: Rgb;
	diffDel: Rgb;
}

/** Resolve the measured surfaces: translucent backgrounds composite over the (opaque) page background. */
export function surfaces(get: (token: ThemeToken) => Rgb, scheme: ThemeScheme): Surfaces {
	const floor: Rgb =
		scheme === "dark" ? { r: 0, g: 0, b: 0, a: 1 } : { r: 255, g: 255, b: 255, a: 1 };
	const bg = composite(get("bg"), floor);
	const panel = composite(get("panel"), bg);
	return {
		bg,
		panel,
		deep: composite(get("bg-deep"), bg),
		diffAdd: composite(get("diff-add-bg"), panel),
		diffDel: composite(get("diff-del-bg"), panel),
	};
}

function hueReason(rgb: Rgb): string | null {
	const h = hslHue(rgb);
	if (h === null) return null;
	// Red wraps around 0 (340-20); green spans 75-170 (HSL degrees).
	if (h >= 340 || h <= 20) return "reads as red (status color)";
	if (h >= 75 && h <= 170) return "reads as green (status color)";
	return null;
}

/** Contrast and hue findings for a fully resolved variant (every token a valid color string). */
export function contrastWarnings(
	tokens: Readonly<Record<ThemeToken, string>>,
	scheme: ThemeScheme,
): ThemeContrastWarning[] {
	const colors = new Map<ThemeToken, Rgb>();
	const get = (token: ThemeToken): Rgb => {
		let color = colors.get(token);
		if (!color) {
			color = parseColor(tokens[token]) ?? { r: 0, g: 0, b: 0, a: 1 };
			colors.set(token, color);
		}
		return color;
	};
	const s = surfaces(get, scheme);
	const warnings: ThemeContrastWarning[] = [];
	const check = (fg: ThemeToken, bg: ThemeToken, bgColor: Rgb): void => {
		const fgColor = composite(get(fg), bgColor);
		const ratio = contrastRatio(fgColor, bgColor);
		if (ratio < MIN_CONTRAST) {
			warnings.push({
				kind: "contrast",
				fg,
				bg,
				ratio: Math.floor(ratio * 100) / 100,
				min: MIN_CONTRAST,
			});
		}
	};
	for (const fg of TEXT_TOKENS) {
		check(fg, "bg", s.bg);
		check(fg, "panel", s.panel);
	}
	for (const fg of [...TOOL_TOKENS, ...SYNTAX_TOKENS]) {
		check(fg, "panel", s.panel);
		check(fg, "bg-deep", s.deep);
	}
	for (const fg of [...SYNTAX_TOKENS, "text"] as const) {
		check(fg, "diff-add-bg", s.diffAdd);
		check(fg, "diff-del-bg", s.diffDel);
	}
	for (const token of TOOL_TOKENS) {
		const reason = hueReason(get(token));
		if (reason) warnings.push({ kind: "hue", token, reason });
	}
	return warnings;
}
