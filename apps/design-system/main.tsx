import { render } from "solid-js/web";
import { initTheme } from "../web/prefs/theme";
// Same global stylesheet production loads (index.tsx), then the showcase chrome.
import "../web/styles.css";
import "./showcase.css";
import { installDaemon } from "./daemon";
import { Shell } from "./shell";

// Deliberately NOT importing apps/web/index.tsx: its render boots App, whose
// onMount opens the SSE connection and probes /auth/session. The showcase
// imports components and the (side-effect free) store module; only the App
// story mounts App, against the design server's fixture /events stream.
initTheme();
installDaemon();
render(() => <Shell />, document.getElementById("root")!);
