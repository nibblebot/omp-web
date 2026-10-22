/** Structural slice of AgentSession needed for explicit settings-panel actions. */
export interface AgentSessionLike {
	settleMemoryBackend(): Promise<void>;
}

/**
 * The registered setting is already persisted by the caller. The SDK owns
 * live setting listeners for modes, sampling, advisor, prompt and memory; the
 * default thinking level only seeds new sessions, so editing it never changes
 * the attached one. Only a memory backend switch needs a wait here.
 */
export async function applySettingSideEffects(
	session: AgentSessionLike,
	path: string,
): Promise<void> {
	if (path === "memory.backend") {
		// Wait for the SDK-owned transition, without starting it a second time.
		await session.settleMemoryBackend();
	}
}
