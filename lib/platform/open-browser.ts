import { spawn } from "node:child_process";

/**
 * Whether a person launched this process from an interactive terminal on a
 * machine that can show a browser: stdin and stdout are TTYs (agents,
 * scripts, and supervisors never qualify), and on Linux a display exists
 * (an SSH login without forwarding has none). Auto-open gates on this.
 */
export function isInteractiveDesktop(): boolean {
	if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) return false;
	return process.platform !== "linux" || !!process.env.DISPLAY || !!process.env.WAYLAND_DISPLAY;
}

/**
 * Open `url` in the default browser: detached, stdio ignored, unref'd. A
 * launcher that cannot be spawned prints one stderr warning prefixed with
 * `label`; the caller goes on serving.
 */
export function openBrowser(url: string, label: string): void {
	const [cmd, args]: [string, string[]] =
		process.platform === "darwin"
			? ["open", [url]]
			: process.platform === "win32"
				? ["cmd", ["/c", "start", '""', url]]
				: ["xdg-open", [url]];
	try {
		const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
		child.on("error", (err) => console.error(`${label}: could not open a browser: ${err.message}`));
		child.unref();
	} catch (err) {
		console.error(
			`${label}: could not open a browser: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}
