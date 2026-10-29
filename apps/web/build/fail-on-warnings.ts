import { createLogger, type Logger } from "vite";

/**
 * Logger for production builds (`customLogger` when vite's command is
 * `build`): warnings print as usual and are counted, and once any was logged
 * the process exits non-zero, so `bun run build:web` (and `bun run check` and
 * the release gate that run it) fails. Vite's own warnings, Rolldown's
 * (`INEFFECTIVE_DYNAMIC_IMPORT`, the chunk size limit, ...) and plugins'
 * `this.warn` all reach this logger, at any stage.
 *
 * The verdict is taken at process exit, not by throwing from `warn` or in a
 * plugin hook: Rolldown swallows an exception thrown from a warning raised by
 * a native plugin (the chunk size reporter), and `closeBundle` hooks run in
 * parallel, so a hook-time check can miss a later warning. Installs one
 * `exit` listener on the calling process.
 */
export function failOnWarningsLogger(): Logger {
	const logger = createLogger();
	let warnings = 0;
	process.once("exit", () => {
		if (warnings === 0) return;
		console.error(
			`\nvite build logged ${warnings} warning${warnings === 1 ? "" : "s"} (see above); the web build allows none`,
		);
		if (!process.exitCode) process.exitCode = 1;
	});
	return {
		...logger,
		get hasWarned() {
			return logger.hasWarned;
		},
		warn(msg, opts) {
			warnings += 1;
			logger.warn(msg, opts);
		},
		warnOnce(msg, opts) {
			warnings += 1;
			logger.warnOnce(msg, opts);
		},
	};
}
