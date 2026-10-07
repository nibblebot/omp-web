import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReviewAnnotationDto } from "#lib/wire/protocol";
import type { SessionEntry } from "../session-entry";
import { createAnnotationMethods, reviewContentHash } from "../review-annotations";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
	const cwd = await mkdtemp(join(tmpdir(), "omp-review-annotation-"));
	roots.push(cwd);
	const branch: Array<Record<string, unknown>> = [];
	const prompts: string[] = [];
	const manager = {
		getBranch: () => branch,
		getSessionId: () => "annotation-session",
		appendCustomEntry(customType: string, data: unknown) {
			const id = `entry-${branch.length}`;
			branch.push({ type: "custom", id, customType, data: structuredClone(data) });
			return id;
		},
	};
	const session = {
		sessionManager: manager,
		prompt: async (text: string) => {
			prompts.push(text);
		},
	};
	const entry = { cwd, session } as unknown as SessionEntry;
	return { cwd, branch, prompts, session, entry, methods: createAnnotationMethods() };
}

describe("durable review annotations", () => {
	test("content drift retains original anchor and reopening restores the durable ID", async () => {
		const { cwd, branch, session, entry, methods } = await fixture();
		await Bun.write(join(cwd, "file.txt"), "original\nsecond\n");
		const anchor = {
			kind: "file",
			path: "file.txt",
			start: 1,
			end: 1,
			contentHash: reviewContentHash("original"),
		} as const;
		const created = (await methods.annotationCreate(entry, [
			{ source: "file", anchor, note: "Explain this" },
		])) as ReviewAnnotationDto;
		expect(created.status).toBe("current");
		await Bun.write(join(cwd, "file.txt"), "changed\nsecond\n");
		const resumed = {
			cwd,
			session: {
				...session,
				sessionManager: { ...session.sessionManager, getBranch: () => structuredClone(branch) },
			},
		} as unknown as SessionEntry;
		const listed = (await createAnnotationMethods().annotationList(
			resumed,
			[],
		)) as ReviewAnnotationDto[];
		expect(listed[0].id).toBe(created.id);
		expect(listed[0].status).toBe("stale");
		expect(listed[0].anchor).toEqual(anchor);
	});

	test("renaming an anchored file or removing a transcript entry orphans rather than moves it", async () => {
		const { cwd, branch, entry, methods } = await fixture();
		await Bun.write(join(cwd, "file.txt"), "original\n");
		const created = (await methods.annotationCreate(entry, [
			{
				source: "file",
				anchor: {
					kind: "file",
					path: "file.txt",
					start: 1,
					end: 1,
					contentHash: reviewContentHash("original"),
				},
				note: "Keep the original location",
			},
		])) as ReviewAnnotationDto;
		await rename(join(cwd, "file.txt"), join(cwd, "renamed.txt"));
		expect(((await methods.annotationList(entry, [])) as ReviewAnnotationDto[])[0].status).toBe(
			"orphaned",
		);
		branch.push({ type: "message", id: "message-1", message: { content: "reply" } });
		const reply = (await methods.annotationCreate(entry, [
			{
				source: "reply",
				anchor: {
					kind: "entry",
					anchor: {
						sessionId: "annotation-session",
						entryId: "message-1",
						revision: reviewContentHash("reply"),
					},
				},
				note: "Clarify",
			},
		])) as ReviewAnnotationDto;
		branch.splice(
			branch.findIndex((item) => item.id === "message-1"),
			1,
		);
		const listed = (await methods.annotationList(entry, [])) as ReviewAnnotationDto[];
		expect(listed.find((item) => item.id === reply.id)?.status).toBe("orphaned");
		expect(listed.find((item) => item.id === created.id)?.anchor).toEqual(created.anchor);
	});

	test("stale note revisions refuse overwrite and explicit reanchor requires current content", async () => {
		const { entry, methods } = await fixture();
		const anchor = { kind: "text", text: "quoted", contentHash: reviewContentHash("quoted") };
		const created = (await methods.annotationCreate(entry, [
			{ source: "text", anchor, note: "First" },
		])) as ReviewAnnotationDto;
		const updated = (await methods.annotationUpdate(entry, [
			{ id: created.id, revision: created.revision, note: "Newer" },
		])) as ReviewAnnotationDto;
		await expect(
			methods.annotationUpdate(entry, [
				{ id: created.id, revision: created.revision, note: "Overwrite" },
			]),
		).rejects.toMatchObject({ code: "stale" });
		await expect(
			methods.annotationReanchor(entry, [
				{
					id: updated.id,
					revision: updated.revision,
					anchor: { kind: "text", text: "new", contentHash: reviewContentHash("old") },
				},
			]),
		).rejects.toMatchObject({ code: "stale" });
		expect(((await methods.annotationList(entry, [])) as ReviewAnnotationDto[])[0].note).toBe(
			"Newer",
		);
	});

	test("default insert returns frozen feedback only; submit is explicit and GitHub is refused", async () => {
		const { cwd, entry, prompts, methods } = await fixture();
		await Bun.write(join(cwd, "file.txt"), "original\n");
		const created = (await methods.annotationCreate(entry, [
			{
				source: "file",
				anchor: {
					kind: "file",
					path: "file.txt",
					start: 1,
					end: 1,
					contentHash: reviewContentHash("original"),
				},
				note: "Explain original",
			},
		])) as ReviewAnnotationDto;
		await Bun.write(join(cwd, "file.txt"), "replacement\n");
		const composed = (await methods.annotationCompose(entry, [{ ids: [created.id] }])) as {
			intent: string;
			prompt: string;
			submitted: boolean;
		};
		expect(composed.intent).toBe("insert");
		expect(composed.submitted).toBe(false);
		expect(composed.prompt).toContain("original");
		expect(composed.prompt).not.toContain("replacement");
		expect(prompts).toHaveLength(0);
		await expect(
			methods.annotationCompose(entry, [{ ids: [created.id], intent: "github" }]),
		).rejects.toMatchObject({ code: "not_eligible" });
		expect(prompts).toHaveLength(0);
		await methods.annotationCompose(entry, [{ ids: [created.id], intent: "submit" }]);
		expect(prompts).toHaveLength(1);
	});
});
