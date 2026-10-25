import { Settings } from "@oh-my-pi/pi-coding-agent";

/**
 * Boot the process-global Settings for a session or fleet process. Edits to the
 * config files made by another process (the fleet writes the same config.yml)
 * must reach this process's in-memory settings, so new and resumed sessions
 * read the current value. The SDK CLI starts the same watcher at boot.
 */
export async function initSettings(
	options: Parameters<typeof Settings.init>[0] = {},
): Promise<Settings> {
	const settings = await Settings.init(options);
	settings.startWatching();
	return settings;
}
