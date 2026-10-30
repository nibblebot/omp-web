/**
 * Resolves a variant: every optional token a file omits gets a concrete value derived
 * from the core, aware of the scheme (dark or light). Values a file sets are kept
 * verbatim. No runtime color-mix: everything is computed here.
 *
 * The rules mirror the original Catppuccin palettes: how surfaces, status, diff and
 * settings tokens relate to the core. `tool-*` and `syn-*` are contrast-solved
 * (fixed hues, lightness adjusted in OKLCH until 4.5:1 on `panel`, `bg-deep` and the
 * diff backgrounds composited over `panel`).
 */
import {
	composite,
	contrastRatio,
	formatColor,
	fromOklch,
	mix,
	parseColor,
	toOklch,
	withAlpha,
} from "./color";
import type { Rgb } from "./color";
import { adjustLightness, solveLightness, surfaces } from "./contrast";
import type { Surfaces } from "./contrast";
import type {
	ThemeOptionalToken,
	ThemeScheme,
	ThemeToken,
	ThemeVariant,
	ThemeVariantInput,
} from "./types";
import { THEME_TOKENS } from "./types";

const WHITE: Rgb = { r: 255, g: 255, b: 255, a: 1 };
const BLACK: Rgb = { r: 0, g: 0, b: 0, a: 1 };

/** OKLCH hue and chroma of a contrast-solved token. Tool hues avoid red and green. */
const SOLVED_HUES: Readonly<Record<string, { h: number; c: number }>> = {
	"tool-shell": { h: 305, c: 0.12 },
	"tool-read": { h: 255, c: 0.12 },
	"tool-write": { h: 70, c: 0.13 },
	"tool-search": { h: 205, c: 0.1 },
	"tool-agents": { h: 340, c: 0.13 },
	"tool-other": { h: 250, c: 0.03 },
	"syn-keyword": { h: 305, c: 0.12 },
	"syn-string": { h: 145, c: 0.12 },
	"syn-number": { h: 65, c: 0.13 },
	"syn-comment": { h: 250, c: 0.025 },
	"syn-title": { h: 250, c: 0.12 },
	"syn-attr": { h: 205, c: 0.1 },
	"syn-meta": { h: 345, c: 0.12 },
};

interface Context {
	dark: boolean;
	/** The token as written or derived, as parsed (may be translucent). */
	rgb(token: ThemeToken): Rgb;
	/** The token composited over the opaque page background. */
	solid(token: ThemeToken): Rgb;
	/** A translucent token composited over `panel`. */
	overPanel(token: ThemeToken): Rgb;
	surfaces(): Surfaces;
}

type Rule = (c: Context) => Rgb;

/** Tint `status` with a fixed alpha: dark and light values. */
function tint(status: ThemeToken, dark: number, light: number): Rule {
	return (c) => withAlpha(c.solid(status), c.dark ? dark : light);
}

/** Mix two solid tokens: `pct` percent of `a`. */
function blend(a: ThemeToken, b: ThemeToken, pct: number): Rule {
	return (c) => mix(c.solid(a), c.solid(b), pct);
}

function solved(token: string): Rule {
	const { h, c: chroma } = SOLVED_HUES[token]!;
	return (c) => {
		const s = c.surfaces();
		return solveLightness(h, chroma, c.dark ? 0.78 : 0.48, [s.panel, s.deep, s.diffAdd, s.diffDel]);
	};
}

/** `rule`'s color, moved to the nearest lightness that reads on `bg` and `panel` (secondary text is real text). */
function readable(rule: Rule): Rule {
	return (c) => adjustLightness(rule(c), [c.solid("bg"), c.solid("panel")]);
}

/** Diff text: the status color (darkened on light), kept readable on its row. */
function diffText(status: ThemeToken, bg: ThemeToken): Rule {
	return (c) => {
		const base = c.dark ? c.solid(status) : mix(c.solid(status), BLACK, 85);
		return adjustLightness(base, [c.solid("panel"), c.overPanel(bg)]);
	};
}

const RULES: Readonly<Record<ThemeOptionalToken, Rule>> = {
	// surfaces
	"bg-deep": (c) => {
		const bg = toOklch(c.solid("bg"));
		return fromOklch(Math.max(0, bg.l - (c.dark ? 0.06 : 0.045)), bg.c, bg.h);
	},
	"panel-2": blend("bg", "bg-deep", 50),
	btn: (c) => (c.dark ? c.solid("border") : mix(c.solid("border"), c.solid("bg"), 60)),
	hover: (c) => (c.dark ? c.solid("border") : mix(c.solid("bg-deep"), c.solid("bg"), 70)),
	"border-strong": (c) => mix(c.solid("border"), c.solid("text"), c.dark ? 85 : 60),
	backdrop: (c) =>
		c.dark ? withAlpha(c.solid("bg-deep"), 0.65) : withAlpha(c.solid("text"), 0.35),
	"shadow-color": (c) => (c.dark ? { r: 0, g: 0, b: 0, a: 0.4 } : withAlpha(c.solid("text"), 0.2)),
	// text
	"muted-2": readable((c) =>
		c.dark ? mix(c.solid("muted"), c.solid("bg"), 90) : mix(c.solid("muted"), c.solid("text"), 80),
	),
	"muted-3": readable(blend("muted", "text", 50)),
	"shimmer-band": (c) => (c.dark ? c.solid("muted-3") : mix(c.solid("muted-2"), c.solid("bg"), 40)),
	"error-text": (c) => {
		const base = c.dark ? mix(c.solid("error"), WHITE, 60) : mix(c.solid("error"), BLACK, 80);
		return adjustLightness(base, [c.solid("panel"), c.overPanel("error-bg")]);
	},
	// accent
	"accent-dim": tint("accent", 0.22, 0.15),
	"accent-border": tint("accent", 0.45, 0.4),
	purple: (c) => {
		const s = c.surfaces();
		return solveLightness(305, 0.14, c.dark ? 0.78 : 0.5, [s.panel, s.deep, s.bg]);
	},
	// status surfaces
	"success-bg": tint("success", 0.12, 0.11),
	"success-border": tint("success", 0.38, 0.35),
	"warning-bg": tint("warning", 0.12, 0.11),
	"warning-border": tint("warning", 0.38, 0.35),
	"error-bg": tint("error", 0.12, 0.1),
	"error-border": tint("error", 0.4, 0.35),
	"stop-bg": tint("error", 0.12, 0.1),
	// diff
	"diff-add-bg": tint("success", 0.1, 0.1),
	"diff-add-text": diffText("success", "diff-add-bg"),
	"diff-del-bg": tint("error", 0.1, 0.08),
	"diff-del-text": diffText("error", "diff-del-bg"),
	// tool categories and syntax: contrast-solved
	"tool-shell": solved("tool-shell"),
	"tool-read": solved("tool-read"),
	"tool-write": solved("tool-write"),
	"tool-search": solved("tool-search"),
	"tool-agents": solved("tool-agents"),
	"tool-other": solved("tool-other"),
	"syn-keyword": solved("syn-keyword"),
	"syn-string": solved("syn-string"),
	"syn-number": solved("syn-number"),
	"syn-comment": solved("syn-comment"),
	"syn-title": solved("syn-title"),
	"syn-attr": solved("syn-attr"),
	"syn-meta": solved("syn-meta"),
	// settings surfaces
	"settings-accent": (c) => c.rgb("purple"),
	"settings-title": (c) => c.rgb("text"),
	"settings-desc": blend("text", "muted", 80),
	"settings-warning": (c) => c.rgb("warning"),
	"settings-line": blend("border", "bg", 85),
	"settings-divider": blend("border", "bg", 60),
	"settings-fill": blend("border", "bg", 42),
	"settings-track-off": blend("border", "bg", 70),
	"settings-mark-bg": (c) => c.solid("muted"),
	"settings-mark-fg": (c) => {
		const markBg = c.solid("settings-mark-bg");
		const best = [c.solid("bg-deep"), c.solid("text")].reduce((a, b) =>
			contrastRatio(a, markBg) >= contrastRatio(b, markBg) ? a : b,
		);
		return adjustLightness(best, [markBg]);
	},
	// brand mark
	"logo-tile": () => parseColor("#ffc233")!,
	"logo-base": () => parseColor("#1b1033")!,
};

/** Resolve every token of a validated variant. */
export function resolveVariant(scheme: ThemeScheme, input: ThemeVariantInput): ThemeVariant {
	const strings = new Map<ThemeToken, string>();
	const colors = new Map<ThemeToken, Rgb>();
	const solids = new Map<ThemeToken, Rgb>();
	const floor = scheme === "dark" ? BLACK : WHITE;

	const ctx: Context = {
		dark: scheme === "dark",
		rgb(token) {
			let color = colors.get(token);
			if (!color) {
				const explicit = input[token as keyof ThemeVariantInput];
				if (explicit !== undefined) {
					color = parseColor(explicit)!;
					strings.set(token, explicit);
				} else {
					color = RULES[token as ThemeOptionalToken](ctx);
					strings.set(token, formatColor(color));
				}
				colors.set(token, color);
			}
			return color;
		},
		solid(token) {
			let color = solids.get(token);
			if (!color) {
				const bg = token === "bg" ? floor : this.solid("bg");
				color = composite(this.rgb(token), bg);
				solids.set(token, color);
			}
			return color;
		},
		overPanel(token) {
			return composite(this.rgb(token), this.solid("panel"));
		},
		surfaces() {
			return surfaces((token) => this.rgb(token), scheme);
		},
	};

	const tokens = {} as Record<ThemeToken, string>;
	for (const token of THEME_TOKENS) {
		ctx.rgb(token);
		tokens[token] = strings.get(token)!;
	}
	return { scheme, tokens };
}
