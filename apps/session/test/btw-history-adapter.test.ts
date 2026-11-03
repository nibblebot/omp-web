/**
 * BTW history adapter: records saved with images (by the TUI) must reach the
 * browser without their base64 payloads, and a web follow-up must replay each
 * saved turn's images to the model like the SDK does. Real BtwHistoryStore on
 * a temp dir; only the session is faked.
 */

import { afterAll, describe, expect, test } from "bun:test";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import {
	BtwHistoryStore,
	type BtwHistoryRecord,
} from "@oh-my-pi/pi-coding-agent/session/btw-history";
import { cleanupTempDirs, tempDir } from "#lib/testkit/temp-dir.testkit";
import { serviceFor } from "../btw-history-adapter";

afterAll(cleanupTempDirs);

const SESSION_ID = "sess-btw-images";
const ROOT_IMAGE: ImageContent = { type: "image", data: "Uk9PVA==", mimeType: "image/png" };
const FOLLOW_IMAGE: ImageContent = { type: "image", data: "Rk9MTE9X", mimeType: "image/jpeg" };

const savedRecord: BtwHistoryRecord = {
	id: "rec-1",
	leafId: "leaf-1",
	question: "what is in this picture?",
	images: [ROOT_IMAGE],
	answer: "a root",
	status: "complete",
	createdAt: 1000,
	updatedAt: 1001,
	followUps: [
		{
			question: "and this one?",
			images: [FOLLOW_IMAGE],
			answer: "a follow-up",
			status: "complete",
			createdAt: 2000,
			updatedAt: 2001,
		},
	],
};

interface EphemeralArgs {
	promptText: string;
	promptImages?: ImageContent[];
	history?: Array<{ role: string; content: unknown }>;
}

async function openFixture(): Promise<{ session: AgentSession; calls: EphemeralArgs[] }> {
	const artifactsDir = tempDir("omp-btw-images-");
	const seed = await BtwHistoryStore.open(artifactsDir, SESSION_ID);
	await seed.upsert(savedRecord);
	await seed.flush();
	const calls: EphemeralArgs[] = [];
	const session = {
		model: { api: "test-api", provider: "test", id: "test-model" },
		settings: Settings.isolated(),
		sessionManager: {
			getSessionId: () => SESSION_ID,
			getLeafId: () => "leaf-1",
			getArtifactsDir: () => artifactsDir,
			ensureOnDisk: async () => {},
		},
		runEphemeralTurn: async (args: EphemeralArgs) => {
			calls.push(args);
			return {
				replyText: "fresh answer",
				assistantMessage: { role: "assistant", content: [{ type: "text", text: "fresh answer" }] },
			};
		},
	} as unknown as AgentSession;
	return { session, calls };
}

describe("BTW history images", () => {
	test("listed records carry an image count, never the base64 payload", async () => {
		const { session } = await openFixture();
		const service = await serviceFor(session);
		const page = service.listBtwRecords();
		expect(page.total).toBe(1);
		const serialized = JSON.stringify(page);
		expect(serialized).not.toContain(ROOT_IMAGE.data);
		expect(serialized).not.toContain(FOLLOW_IMAGE.data);
		expect(page.records[0]).not.toHaveProperty("images");
		expect(page.records[0]).toMatchObject({ id: "rec-1", imageCount: 1 });
		expect(page.records[0]!.followUps![0]).not.toHaveProperty("images");
		expect(page.records[0]!.followUps![0]).toMatchObject({ imageCount: 1 });
		expect(JSON.stringify(service.listBtwSearch("picture"))).not.toContain(ROOT_IMAGE.data);
		// The paged transcript view never carried images either.
		expect(JSON.stringify(service.pageBtwTurns("rec-1"))).not.toContain(ROOT_IMAGE.data);
	});

	test("a follow-up replays every saved turn's images to the model request", async () => {
		const { session, calls } = await openFixture();
		const service = await serviceFor(session);
		const result = await service.startBtwTurn(session, "one more question", { recordId: "rec-1" });
		expect(calls).toHaveLength(1);
		const history = calls[0]!.history!;
		const users = history.filter((message) => message.role === "user");
		expect(users).toHaveLength(2);
		expect(users[0]!.content).toEqual(expect.arrayContaining([ROOT_IMAGE]));
		expect(users[1]!.content).toEqual(expect.arrayContaining([FOLLOW_IMAGE]));
		// The new follow-up turn itself carries no images, and the returned
		// DTO stays payload-free.
		expect(calls[0]!.promptImages).toBeUndefined();
		expect(JSON.stringify(result)).not.toContain(ROOT_IMAGE.data);
		expect(result.followUps).toHaveLength(2);
		expect(result.followUps![1]).toMatchObject({
			question: "one more question",
			status: "complete",
		});
	});
});
