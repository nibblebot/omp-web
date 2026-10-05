import {
	type ConfiguredThinkingLevel,
	parseConfiguredThinkingLevel,
} from "@oh-my-pi/pi-tui/thinking";

/** Structural slice of AgentSession needed for explicit settings-panel actions. */
export interface AgentSessionLike {
	configuredThinkingLevel(): ConfiguredThinkingLevel | undefined;
	setThinkingLevel(level: ConfiguredThinkingLevel): void;
	settleMemoryBackend(): Promise<void>;
}

/**
 * The registered setting is already persisted by the caller. The SDK owns
 * live setting listeners for modes, sampling, advisor, prompt and memory.
 * Only a local thinking preference edit also switches the running session:
 * config reloads and edits from other sessions must not change that selection.
 */
export async function applySettingSideEffects(
	session: AgentSessionLike,
	path: string,
	value: unknown,
): Promise<void> {
	if (path === "defaultThinkingLevel" && typeof value === "string") {
		const level = parseConfiguredThinkingLevel(value);
		if (level !== undefined && level !== session.configuredThinkingLevel()) {
			session.setThinkingLevel(level);
		}
	} else if (path === "memory.backend") {
		// Wait for the SDK-owned transition, without starting it a second time.
		await session.settleMemoryBackend();
	}
}
