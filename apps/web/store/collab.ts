import type { ClientCommand } from "#lib/wire/protocol";
import { setState } from "../state";
import { settingValue } from "./settings";
import { isConnected, postCommand } from "./transport";

/**
 * Public relay the ShareSheet opt-in uses. Same value as the SDK's
 * DEFAULT_RELAY_URL; sent explicitly and only after the user opts in.
 */
export const PUBLIC_RELAY_URL = "wss://my.omp.sh";

/**
 * True when `collab.relayUrl` names a relay other than the public default. The
 * SDK default is the public relay, so an unset value still needs the opt-in.
 */
export function relayConfigured(): boolean {
	const url = (settingValue<string>("collab.relayUrl") ?? "").trim();
	return url !== "" && url !== PUBLIC_RELAY_URL;
}

/**
 * Start sharing the attached session. Omitting `relayUrl` uses the configured
 * relay; the daemon refuses (collab_status error) when none is configured.
 */
export function startCollabRoom(access: "view" | "control", relayUrl?: string): void {
	if (!isConnected()) return;
	void postCommand({
		type: "collab_start",
		id: crypto.randomUUID(),
		access,
		...(relayUrl !== undefined ? { relayUrl } : {}),
	} satisfies ClientCommand).catch(() => {});
}

/** End the attached session's room. The daemon answers with collab_status off. */
export function stopCollabRoom(): void {
	if (!isConnected()) return;
	void postCommand({ type: "collab_stop", id: crypto.randomUUID() } satisfies ClientCommand).catch(
		() => {},
	);
}

/** Open the ShareSheet (header button). */
export function openShareSheet(): void {
	setState("modal", "share");
}
