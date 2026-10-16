/**
 * Mirrors `visualViewport.height` into the `--app-h` custom property that
 * sizes the app shell (app.css), so the composer stays above the on-screen
 * keyboard on iOS Safari, where neither `100dvh` nor `interactive-widget`
 * shrink for the keyboard. Pinch zoom also shrinks the visual viewport, so
 * updates are skipped while zoomed. Without visualViewport the shell keeps its
 * `100dvh` fallback. Returns the uninstall function.
 */
export function trackViewportHeight(): () => void {
	const viewport = typeof window !== "undefined" ? window.visualViewport : null;
	if (!viewport) return () => {};
	const root = document.documentElement;
	const update = () => {
		if (Math.abs(viewport.scale - 1) > 0.01) return;
		root.style.setProperty("--app-h", `${viewport.height}px`);
	};
	update();
	viewport.addEventListener("resize", update);
	return () => {
		viewport.removeEventListener("resize", update);
		root.style.removeProperty("--app-h");
	};
}
