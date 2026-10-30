/**
 * `/skill:<name>` typed in the web composer arrives as prompt text. AgentSession.prompt never
 * expands it (the SDK's RPC and ACP modes do, ahead of prompt), so the session must dispatch the
 * skill message itself: through the direct prompt, the queued-command drain, and run-now.
 */
import { describe, expect, test } from "bun:test";
import { AgentBusyError } from "@oh-my-pi/pi-agent-core";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SKILL_PROMPT_MESSAGE_TYPE } from "@oh-my-pi/pi-coding-agent/session/messages";
import { createCollabSession } from "../collab-session";
import type { SessionEntry } from "../session-entry";

const image = { type: "image", data: "AAAA", mimeType: "image/png" } as const;

interface CustomCall {
	message: Record<string, unknown>;
	options: Record<string, unknown> | undefined;
}

/** A session that records `prompt` and `promptCustomMessage` calls; `busy` refuses both like a streaming turn. */
function fakeSession(
	options: {
		busy?: boolean;
		enableSkillCommands?: boolean;
		skills?: string[];
		buildError?: Error;
	} = {},
) {
	const prompts: Array<{ text: string; images: unknown }> = [];
	const customs: CustomCall[] = [];
	const built: Array<{ name: string; args: string }> = [];
	const session = {
		isStreaming: options.busy ?? false,
		subscribe: () => () => undefined,
		skillsSettings: { enableSkillCommands: options.enableSkillCommands ?? true },
		skills: (options.skills ?? ["probe"]).map((name) => ({ name })),
		buildUserSkillPrompt: async (skill: { name: string }, input: { args: string }) => {
			if (options.buildError) throw options.buildError;
			built.push({ name: skill.name, args: input.args });
			return {
				message: `EXPANDED ${skill.name}: ${input.args}`,
				details: { name: skill.name, args: input.args },
			};
		},
		prompt: async (text: string, opts?: { images?: unknown }) => {
			prompts.push({ text, images: opts?.images });
			if (options.busy) throw new AgentBusyError();
		},
		promptCustomMessage: async (
			message: Record<string, unknown>,
			opts?: Record<string, unknown>,
		) => {
			if (options.busy) throw new AgentBusyError();
			customs.push({ message, options: opts });
			return true;
		},
	};
	return { session: session as unknown as AgentSession, prompts, customs, built };
}

function entryWith(session: AgentSession): SessionEntry {
	return {
		handle: "s1",
		cwd: "/tmp",
		session,
		queuedCommands: { commands: [], paused: false, draining: false },
	} as unknown as SessionEntry;
}

function collab() {
	return createCollabSession({
		config: { idleTimeoutMs: 0 } as never,
		agentDir: "",
		authStorage: {} as never,
		modelRegistry: {} as never,
		settings: {} as never,
		broker: {
			broadcastState: async () => {},
			broadcastAvailableCommands: async () => {},
		} as never,
	});
}

describe("/skill: invocations reach the model expanded", () => {
	test("a direct prompt dispatches the skill message, not the literal text", async () => {
		const { session, prompts, customs, built } = fakeSession();
		await collab().fireAndForgetPrompt(entryWith(session), "/skill:probe look here", undefined);
		expect(prompts).toEqual([]);
		expect(built).toEqual([{ name: "probe", args: "look here" }]);
		expect(customs).toEqual([
			{
				message: {
					customType: SKILL_PROMPT_MESSAGE_TYPE,
					content: "EXPANDED probe: look here",
					display: true,
					details: { name: "probe", args: "look here" },
					attribution: "user",
				},
				options: { queueChipText: "/skill:probe look here" },
			},
		]);
	});

	test("images attach to the skill message", async () => {
		const { session, prompts, customs } = fakeSession();
		await collab().fireAndForgetPrompt(entryWith(session), "/skill:probe", [image] as never);
		expect(prompts).toEqual([]);
		expect(customs[0]?.message.content).toEqual([
			{ type: "text", text: "EXPANDED probe: " },
			image,
		]);
	});

	test("the web prompt path (builtins first, then the prompt) expands the skill", async () => {
		const { session, prompts, customs } = fakeSession();
		const deps = collab();
		const entry = entryWith(session);
		const consumed = await deps.runBuiltinSlashCommand(entry, "/skill:probe go", undefined);
		if (!consumed) await deps.fireAndForgetPrompt(entry, "/skill:probe go", undefined);
		expect(prompts).toEqual([]);
		expect(customs).toHaveLength(1);
	});

	test("a queued skill command is expanded when the drain runs it", async () => {
		const { session, prompts, customs } = fakeSession();
		const entry = entryWith(session);
		await collab().runCommandNow(entry, { text: "/skill:probe later", images: undefined });
		expect(prompts).toEqual([]);
		expect(customs).toHaveLength(1);
		expect(customs[0]?.message.content).toBe("EXPANDED probe: later");
	});

	test("a skill refused as busy queues its original text", async () => {
		const { session, prompts, customs } = fakeSession({ busy: true });
		const entry = entryWith(session);
		await collab().fireAndForgetPrompt(entry, "/skill:probe later", undefined);
		expect(prompts).toEqual([]);
		expect(customs).toEqual([]);
		expect(entry.queuedCommands.commands).toEqual([
			{ text: "/skill:probe later", images: undefined },
		]);
	});

	test("an unknown skill falls through to the literal prompt", async () => {
		const { session, prompts, customs } = fakeSession();
		await collab().fireAndForgetPrompt(entryWith(session), "/skill:nope x", undefined);
		expect(customs).toEqual([]);
		expect(prompts).toEqual([{ text: "/skill:nope x", images: undefined }]);
	});

	test("disabled skill commands fall through to the literal prompt", async () => {
		const { session, prompts, customs } = fakeSession({ enableSkillCommands: false });
		await collab().fireAndForgetPrompt(entryWith(session), "/skill:probe x", undefined);
		expect(customs).toEqual([]);
		expect(prompts).toEqual([{ text: "/skill:probe x", images: undefined }]);
	});

	test("plain text is untouched", async () => {
		const { session, prompts, customs } = fakeSession();
		await collab().fireAndForgetPrompt(entryWith(session), "hello", undefined);
		expect(customs).toEqual([]);
		expect(prompts).toEqual([{ text: "hello", images: undefined }]);
	});
});
