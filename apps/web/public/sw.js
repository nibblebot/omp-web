// Notification-only service worker. It has NO fetch handler on purpose: it
// never intercepts navigations, /ws, /ctl, /auth, /callback or downloads, so a
// release can never be shadowed by a stale cached shell. It exists because
// Android Chrome rejects `new Notification()`; pages show notifications
// through `registration.showNotification()` and this worker handles the tap.
// Served with Cache-Control: no-cache so a changed worker installs promptly.

self.addEventListener("install", () => {
	void self.skipWaiting();
});

self.addEventListener("activate", (event) => {
	event.waitUntil(self.clients.claim());
});

// A tap focuses an open window and asks it to switch to the notified session
// ({ type: "omp-notification-click", workspaceId }); with no window open it
// launches the app at that session's route (data.url, a same-origin path).
self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	const data = event.notification.data;
	if (data === null || typeof data !== "object") return;
	event.waitUntil(
		(async () => {
			const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
			const open = windows.find((client) => "focus" in client);
			if (open !== undefined) {
				await open.focus();
				open.postMessage({ type: "omp-notification-click", workspaceId: data.workspaceId });
				return;
			}
			if (typeof data.url === "string") await self.clients.openWindow(data.url);
		})(),
	);
});
