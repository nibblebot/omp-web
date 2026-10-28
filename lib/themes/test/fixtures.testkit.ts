import type { ThemeVariantInput } from "../types";

export const DARK_CORE = {
	bg: "#1e1e2e",
	panel: "#313244",
	text: "#cdd6f4",
	muted: "#a6adc8",
	border: "#45475a",
	accent: "#89b4fa",
	success: "#a6e3a1",
	warning: "#f9e2af",
	error: "#f38ba8",
} satisfies ThemeVariantInput;

export const LIGHT_CORE = {
	bg: "#eff1f5",
	panel: "#ffffff",
	text: "#4c4f69",
	muted: "#575a6e",
	border: "#ccd0da",
	accent: "#1a55d6",
	success: "#256f1a",
	warning: "#92400e",
	error: "#c20d34",
} satisfies ThemeVariantInput;

/** Dark theme whose surfaces sit close to mid-gray, so every solved color must be pushed far. */
export const MURKY_DARK_CORE = {
	bg: "#4a4a52",
	panel: "#585862",
	text: "#f0f0f4",
	muted: "#d0d0d8",
	border: "#6a6a76",
	accent: "#9ab0ff",
	success: "#90d090",
	warning: "#e0d080",
	error: "#f09090",
} satisfies ThemeVariantInput;

/** Light theme with a dim, low-contrast panel. */
export const MURKY_LIGHT_CORE = {
	bg: "#c4c4bc",
	panel: "#cfcfc6",
	text: "#1c1c1a",
	muted: "#3a3a36",
	border: "#a8a8a0",
	accent: "#1a3aa0",
	success: "#1e5a1e",
	warning: "#6a4a00",
	error: "#8a1a1a",
} satisfies ThemeVariantInput;

/** A minimal valid theme document with a dark variant (and a light one unless `light` is false). */
export function themeDoc(name: string, options: { light?: boolean } = {}): Record<string, unknown> {
	return {
		schemaVersion: 1,
		name,
		variants: {
			dark: { ...DARK_CORE },
			...(options.light === false ? {} : { light: { ...LIGHT_CORE } }),
		},
	};
}
