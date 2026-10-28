/**
 * Page lifecycle wiring for the browser socket. A mobile tab is frozen, its
 * screen turned off, or its network swapped without the page being told
 * through the socket, so the reconnect ladder and the silence timer run late.
 * These events let the page react the moment it can: foregrounding, a bfcache
 * restore and the network returning redial at once (resumeConnection); losing
 * the network drops the socket and holds the dials (suspendConnection).
 */
import { resumeConnection, suspendConnection } from "../state";

/**
 * Run `callback` whenever the page may have been away: it became visible
 * again, or (on desktop, where alt-tabbing never hides the page) the window
 * regained focus. Android Chrome does not reliably fire `focus` on resume, so
 * `visibilitychange` is the signal that matters there. Returns the remover.
 */
export function onForeground(callback: () => void): () => void {
	const onVisibility = (): void => {
		if (document.visibilityState === "visible") callback();
	};
	document.addEventListener("visibilitychange", onVisibility);
	window.addEventListener("focus", callback);
	return () => {
		document.removeEventListener("visibilitychange", onVisibility);
		window.removeEventListener("focus", callback);
	};
}

/** Wire the socket to the page lifecycle; returns the remover (call on cleanup). */
export function installLifecycle(): () => void {
	const onVisibility = (): void => {
		if (document.visibilityState === "visible") resumeConnection();
	};
	// `persisted` is a bfcache restore; a plain load already dialled in App's onMount.
	const onPageShow = (event: PageTransitionEvent): void => {
		if (event.persisted) resumeConnection();
	};
	document.addEventListener("visibilitychange", onVisibility);
	window.addEventListener("pageshow", onPageShow);
	window.addEventListener("online", resumeConnection);
	window.addEventListener("offline", suspendConnection);
	return () => {
		document.removeEventListener("visibilitychange", onVisibility);
		window.removeEventListener("pageshow", onPageShow);
		window.removeEventListener("online", resumeConnection);
		window.removeEventListener("offline", suspendConnection);
	};
}
