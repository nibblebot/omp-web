/**
 * Color math for theme files: parsing the allowed formats (`#rgb`, `#rrggbb`,
 * `#rrggbbaa`, `oklch(L% C h)`, `oklch(L% C h / a)`), sRGB <-> OKLab/OKLCH,
 * WCAG contrast, alpha compositing and formatting. Browser-safe, no imports.
 *
 * Derived colors are always emitted as `#rrggbb` / `#rrggbbaa`, which `parseColor`
 * reads back unchanged.
 */

/** An sRGB color: channels are 0..255 integers, alpha is 0..1. */
export interface Rgb {
	r: number;
	g: number;
	b: number;
	a: number;
}

/** An OKLCH color: lightness 0..1, chroma >= 0, hue in degrees, alpha 0..1. */
export interface Oklch {
	l: number;
	c: number;
	h: number;
	a: number;
}

const NUM = String.raw`(?:\d+\.?\d*|\.\d+)`;
const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const OKLCH_RE = new RegExp(
	String.raw`^oklch\(\s*(${NUM})%\s+(${NUM})\s+(${NUM})(?:deg)?\s*(?:/\s*(${NUM})(%?)\s*)?\)$`,
	"i",
);

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const byte = (v: number): number => clamp(Math.round(v), 0, 255);

function srgbToLinear(c: number): number {
	const v = c / 255;
	return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(v: number): number {
	const c = v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
	return c * 255;
}

/** Linear-light sRGB (0..1 each) to OKLab. */
function linearToOklab(r: number, g: number, b: number): [number, number, number] {
	const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
	const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
	const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
	return [
		0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
		1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
		0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
	];
}

/** OKLab to linear-light sRGB (unclamped). */
function oklabToLinear(L: number, a: number, b: number): [number, number, number] {
	const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
	const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
	const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
	return [
		4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
		-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
		-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
	];
}

const GAMUT_EPS = 1e-4;

function inGamut(rgb: readonly [number, number, number]): boolean {
	return rgb.every((v) => v >= -GAMUT_EPS && v <= 1 + GAMUT_EPS);
}

/** An OKLCH color as sRGB. Out-of-gamut colors lose chroma (hue and lightness kept) until they fit. */
export function fromOklch(l: number, c: number, h: number, a = 1): Rgb {
	const alpha = clamp(a, 0, 1);
	if (l <= 0) return { r: 0, g: 0, b: 0, a: alpha };
	if (l >= 1) return { r: 255, g: 255, b: 255, a: alpha };
	const rad = (h * Math.PI) / 180;
	const at = (chroma: number) => oklabToLinear(l, chroma * Math.cos(rad), chroma * Math.sin(rad));
	let lin = at(Math.max(0, c));
	if (!inGamut(lin)) {
		let lo = 0;
		let hi = Math.max(0, c);
		for (let i = 0; i < 24; i++) {
			const mid = (lo + hi) / 2;
			if (inGamut(at(mid))) lo = mid;
			else hi = mid;
		}
		lin = at(lo);
	}
	return {
		r: byte(linearToSrgb(clamp(lin[0], 0, 1))),
		g: byte(linearToSrgb(clamp(lin[1], 0, 1))),
		b: byte(linearToSrgb(clamp(lin[2], 0, 1))),
		a: alpha,
	};
}

/** sRGB to OKLCH. Achromatic colors get hue 0. */
export function toOklch(rgb: Rgb): Oklch {
	const [L, a, b] = linearToOklab(srgbToLinear(rgb.r), srgbToLinear(rgb.g), srgbToLinear(rgb.b));
	const c = Math.hypot(a, b);
	const h = c < 1e-4 ? 0 : ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
	return { l: L, c, h, a: rgb.a };
}

/** Parse one allowed color format; null for anything else (including `rgb()`, named colors, `#rgba`). */
export function parseColor(value: string): Rgb | null {
	if (value.startsWith("#")) {
		if (!HEX_RE.test(value)) return null;
		let hex = value.slice(1);
		if (hex.length === 3) hex = [...hex].map((ch) => ch + ch).join("");
		const n = (i: number) => Number.parseInt(hex.slice(i, i + 2), 16);
		return { r: n(0), g: n(2), b: n(4), a: hex.length === 8 ? n(6) / 255 : 1 };
	}
	const m = OKLCH_RE.exec(value);
	if (!m) return null;
	const l = Number(m[1]) / 100;
	const c = Number(m[2]);
	const h = Number(m[3]);
	if (![l, c, h].every(Number.isFinite) || c < 0) return null;
	let alpha = 1;
	if (m[4] !== undefined) {
		alpha = m[5] ? Number(m[4]) / 100 : Number(m[4]);
		if (!Number.isFinite(alpha)) return null;
	}
	return fromOklch(clamp(l, 0, 1), c, ((h % 360) + 360) % 360, alpha);
}

/** True when `value` is one of the allowed color formats. */
export function isColor(value: unknown): value is string {
	return typeof value === "string" && parseColor(value) !== null;
}

const hex2 = (v: number): string => byte(v).toString(16).padStart(2, "0");

/** `#rrggbb`, or `#rrggbbaa` when the color is translucent. */
export function formatColor(rgb: Rgb): string {
	const base = `#${hex2(rgb.r)}${hex2(rgb.g)}${hex2(rgb.b)}`;
	const alpha = byte(rgb.a * 255);
	return alpha === 255 ? base : `${base}${hex2(alpha)}`;
}

/** An OKLCH color as a formatted hex string. */
export function formatOklch(l: number, c: number, h: number, a = 1): string {
	return formatColor(fromOklch(l, c, h, a));
}

/** The same color with a new alpha. */
export function withAlpha(rgb: Rgb, a: number): Rgb {
	return { ...rgb, a: clamp(a, 0, 1) };
}

/** `fg` composited over an opaque `bg`; the result is opaque. */
export function composite(fg: Rgb, bg: Rgb): Rgb {
	const a = fg.a;
	return {
		r: byte(fg.r * a + bg.r * (1 - a)),
		g: byte(fg.g * a + bg.g * (1 - a)),
		b: byte(fg.b * a + bg.b * (1 - a)),
		a: 1,
	};
}

/** `color-mix(in srgb, a pctA%, b)` for opaque colors: `pctA` is 0..100. */
export function mix(a: Rgb, b: Rgb, pctA: number): Rgb {
	const t = clamp(pctA, 0, 100) / 100;
	return {
		r: byte(a.r * t + b.r * (1 - t)),
		g: byte(a.g * t + b.g * (1 - t)),
		b: byte(a.b * t + b.b * (1 - t)),
		a: a.a * t + b.a * (1 - t),
	};
}

/** WCAG relative luminance of an opaque color. */
export function relativeLuminance(rgb: Rgb): number {
	return 0.2126 * srgbToLinear(rgb.r) + 0.7152 * srgbToLinear(rgb.g) + 0.0722 * srgbToLinear(rgb.b);
}

/** WCAG contrast ratio (1..21) between two opaque colors. */
export function contrastRatio(a: Rgb, b: Rgb): number {
	const la = relativeLuminance(a);
	const lb = relativeLuminance(b);
	return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** HSL hue in degrees, or null when the color is nearly achromatic (spread under 6%). */
export function hslHue(rgb: Rgb): number | null {
	const r = rgb.r / 255;
	const g = rgb.g / 255;
	const b = rgb.b / 255;
	const max = Math.max(r, g, b);
	const d = max - Math.min(r, g, b);
	if (d < 0.06) return null;
	let h: number;
	if (max === r) h = ((g - b) / d) % 6;
	else if (max === g) h = (b - r) / d + 2;
	else h = (r - g) / d + 4;
	return (h * 60 + 360) % 360;
}
