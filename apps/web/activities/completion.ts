/** A completion estimate clamped to whole numbers in 0-100; NaN reads as 0. */
export function clampPercent(percent: number): number {
	if (!Number.isFinite(percent)) return 0;
	return Math.max(0, Math.min(100, Math.round(percent)));
}

/**
 * Tooltip for a completion estimate: `Estimated 40% complete · writing tests`.
 * The stage is left out when unknown.
 */
export function completionTitle(percent: number, stage?: string): string {
	const parts = [`Estimated ${clampPercent(percent)}% complete`];
	if (stage !== undefined && stage !== "") parts.push(stage);
	return parts.join(" \u00b7 ");
}
