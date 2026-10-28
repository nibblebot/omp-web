/**
 * The notification-only service worker (public/sw.js). Android Chrome
 * rejects `new Notification()`, so notifications go through the worker's
 * registration there; the worker has no fetch handler and never touches the
 * app's traffic. Registration needs a secure context (HTTPS or localhost);
 * anywhere else, or before the worker is active, callers fall back to the
 * page-level Notification constructor.
 */
import { formatRoute } from "./route";

const SW_URL = "/sw.js";

/** What sw.js posts to a window when a notification is tapped. */
const CLICK_MESSAGE = "omp-notification-click";

/** The active registration; null until the worker is ready or when none can register. */
let registration: ServiceWorkerRegistration | null = null;

/**
 * Register the worker and route notification taps to `onNotificationClick`
 * (the tapped session's workspace id). A no-op outside a secure context or
 * without service worker support; registration failures are swallowed because
 * the page-level notification path still works.
 */
export function registerServiceWorker(onNotificationClick: (workspaceId: string) => void): void {
	if (!globalThis.isSecureContext || !("serviceWorker" in navigator)) return;
	navigator.serviceWorker.addEventListener("message", (event: MessageEvent<unknown>) => {
		const data = event.data;
		if (data === null || typeof data !== "object") return;
		const { type, workspaceId } = data as { type?: unknown; workspaceId?: unknown };
		if (type === CLICK_MESSAGE && typeof workspaceId === "string") onNotificationClick(workspaceId);
	});
	void navigator.serviceWorker
		.register(SW_URL)
		.then(() => navigator.serviceWorker.ready)
		.then((ready) => {
			registration = ready;
		})
		.catch(() => undefined);
}

/**
 * Show a session notification through the worker, or null when no worker is
 * active (the caller then uses `new Notification`). The tap payload carries
 * the workspace id and the route to launch the app at when no window is open.
 * Rejects when the browser refuses the notification.
 */
export function showWorkerNotification(
	workspaceId: string,
	title: string,
	options: NotificationOptions,
): Promise<void> | null {
	if (registration === null) return null;
	const url = `/${formatRoute({ kind: "workspace", workspaceId })}`;
	return registration.showNotification(title, { ...options, data: { workspaceId, url } });
}
