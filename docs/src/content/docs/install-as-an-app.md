---
title: Install as an app
description: "Install the web UI on Android or desktop, and what needs a secure context: HTTPS through a proxy, USB debugging, login proxies, notifications and updates."
---

The web UI is an installable web app (manifest, icons, and a notification-only service worker with no offline cache). Chrome on Android installs, shows notifications, and registers the worker only in a secure context: HTTPS, or `http://localhost` / `http://127.0.0.1`. A plain `http://<lan-ip>:<port>` address is not a secure context, so there is no install option or notification permission there, and browser sign-in cannot complete either (the session cookie is `Secure` off loopback).

- **HTTPS through a proxy.** Put the UI port behind an HTTPS reverse proxy (`tailscale serve --bg 4722`, NetBird, or your own) and pass the public origin as `--browser-origin` (see [Running omp-web](/running/#browser-origin)). Open that address in Chrome and choose Install app (or Add to Home screen).
- **USB debugging.** With the phone attached, `adb reverse tcp:4722 tcp:4722` makes `http://localhost:4722` on the phone reach this machine. `localhost` is a secure context, so install and notifications work there for testing.
- **Behind a login proxy.** The manifest link requests credentials (`crossorigin="use-credentials"`), so a proxy that gates the whole origin (Cloudflare Access and similar) can serve it to a signed-in browser.
- **Notifications.** The "Browser Notification Permission" toggle in Web UI settings shows alerts for other sessions through the service worker, which is the only path Android Chrome supports. An alert is raised by the open page, so it needs the app's connection to be alive; a frozen or discarded app raises none, because that would need web push, which omp-web does not use.
- **Updates.** The shell, manifest, and worker are served `Cache-Control: no-cache`; hashed bundles are cached for a year. A new release loads on the next launch. If the app reports it is out of date with the server, use the Reload button in the connection strip.
