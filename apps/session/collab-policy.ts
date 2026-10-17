/**
 * Collab relay choice and autoStart policy. Pure: the daemon feeds in the
 * settings it read and acts on the decision; tests drive the decisions directly.
 */

export type CollabAutoStart = "off" | "view" | "control";

export type RelayChoice = { ok: true; relayUrl: string } | { ok: false; reason: string };

export type AutoStartDecision =
	| { kind: "off" }
	| { kind: "start"; relayUrl: string; access: Exclude<CollabAutoStart, "off"> }
	| { kind: "refuse"; reason: string };

const NO_RELAY_REASON =
	"no relay configured: set collab.relayUrl to a relay started with `omp-web relay --port <n>`";

/**
 * The relay a room is published through: an explicit choice wins, otherwise
 * `collab.relayUrl`. There is deliberately no implicit default: an unset relay
 * is a refusal, never a silent publish to someone else's relay.
 */
export function chooseRelayUrl(configured: string | undefined, explicit?: string): RelayChoice {
	const candidate = (explicit ?? configured ?? "").trim();
	if (candidate === "") return { ok: false, reason: NO_RELAY_REASON };
	let url: URL;
	try {
		url = new URL(candidate);
	} catch {
		return { ok: false, reason: `relay URL is not a valid URL: ${candidate}` };
	}
	if (url.protocol !== "ws:" && url.protocol !== "wss:") {
		return { ok: false, reason: `relay URL must be ws:// or wss://: ${candidate}` };
	}
	return { ok: true, relayUrl: candidate };
}

/** What `collab.autoStart` does at session start. Non-off with no usable relay is refused, with the reason. */
export function decideAutoStart(autoStart: CollabAutoStart, relay: RelayChoice): AutoStartDecision {
	if (autoStart === "off") return { kind: "off" };
	if (!relay.ok)
		return { kind: "refuse", reason: `collab.autoStart=${autoStart} refused: ${relay.reason}` };
	return { kind: "start", relayUrl: relay.relayUrl, access: autoStart };
}
