/**
 * createAgentSession reports an unavailable default model through `modelFallbackMessage` instead
 * of failing. The boot session has no client yet, so the warning is held and handed to the first
 * priming as a `notice` event frame, once.
 */
import { afterAll, describe, expect, spyOn, test } from "bun:test";
import * as sdk from "@oh-my-pi/pi-coding-agent";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { cleanupTempDirs, tempDir } from "#lib/testkit/temp-dir.testkit";
import { createCollabSession } from "../collab-session";

afterAll(cleanupTempDirs);

async function bootWith(modelFallbackMessage: string | undefined) {
	const dir = tempDir("omp-startup-model-notice-");
	const create = spyOn(sdk, "createAgentSession").mockImplementation((async () => ({
		session: {
			sessionFile: undefined,
			settings: Settings.isolated({}),
			subscribe: () => () => {},
			getEnabledToolNames: () => [],
			getMountedXdevToolNames: () => [],
			setPlanProposalHandler: () => {},
			getAllToolNames: () => [],
			sessionManager: {
				getSessionId: () => "boot-session",
				getCwd: () => dir,
				onSessionNameChanged: () => () => {},
			},
		} as unknown as AgentSession,
		mcpManager: undefined,
		setToolUIContext: () => {},
		modelFallbackMessage,
	})) as never);
	try {
		const collab = createCollabSession({
			config: { idleTimeoutMs: 0 } as never,
			agentDir: dir,
			authStorage: {} as never,
			modelRegistry: {} as never,
			settings: {} as never,
			broker: {
				broadcastState: async () => {},
				broadcastAvailableCommands: async () => {},
			} as never,
		});
		await collab.createSession(dir);
		return collab;
	} finally {
		create.mockRestore();
	}
}

describe("start-up model fallback notice", () => {
	test("a fallback message becomes one warning notice for the first priming only", async () => {
		const message = "Default model acme/gone not found. Using acme/other";
		const collab = await bootWith(message);

		expect(collab.takeStartupNoticeFrames()).toEqual([
			{ type: "event", event: { type: "notice", level: "warning", message } },
		]);
		expect(collab.takeStartupNoticeFrames()).toEqual([]);
	});

	test("a session that started on its model primes no notice", async () => {
		const collab = await bootWith(undefined);

		expect(collab.takeStartupNoticeFrames()).toEqual([]);
	});
});
