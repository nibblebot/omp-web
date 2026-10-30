import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEntry } from "../session-entry";
import {
	createPlanReviewMethods,
	exitPlanMode,
	installPlanReviewHandler,
	planReviewWaiting,
} from "../review-plan";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

type Dto = { reviewId: string; version: number; status: string };
type PlanState = { enabled: boolean; planFilePath: string } | undefined;
type Proposal = (title: string) => Promise<unknown>;

async function fixture() {
	const cwd = await mkdtemp(join(tmpdir(), "omp-review-plan-"));
	roots.push(cwd);
	const planFilePath = join(cwd, "PLAN.md");
	await writeFile(planFilePath, "# Plan\n\nStep one.\n");
	const branch: Array<Record<string, unknown>> = [];
	const runtime = {
		planState: undefined as PlanState,
		proposal: null as Proposal | null,
		prompts: [] as string[],
		messages: [] as Array<{ options: unknown }>,
	};
	const session = {
		sessionManager: {
			getBranch: () => branch,
			getSessionId: () => "plan-session",
			getArtifactsDir: () => undefined,
			appendCustomEntry(customType: string, data: unknown) {
				branch.push({
					type: "custom",
					id: `e${branch.length}`,
					customType,
					data: structuredClone(data),
				});
				return `e${branch.length}`;
			},
			appendModeChange: () => undefined,
			flush: async () => undefined,
		},
		getEnabledToolNames: () => ["read"],
		getMountedXdevToolNames: () => [],
		getAllToolNames: () => ["read"],
		setPlanProposalHandler: (handler: Proposal | null) => {
			runtime.proposal = handler;
		},
		preparePlanForReview: async (title: string) => ({ details: { planFilePath, title } }),
		getPlanModeState: () => runtime.planState,
		setPlanModeState: (next: PlanState) => {
			runtime.planState = next;
		},
		subscribe: () => () => undefined,
		markPlanInternalAbortPending: () => undefined,
		clearPlanInternalAbortPending: () => undefined,
		abort: async () => undefined,
		emitNotice: () => undefined,
		isStreaming: false,
		hasAdmittedSubmission: false,
		hasPostPromptWork: false,
		getRoleModelCycle: () => undefined,
		runModeExitTeardown: async (action: () => Promise<void>) => action(),
		restoreNonMCPToolPresentation: async () => undefined,
		applyRoleModel: async () => undefined,
		resetSessionContext: async () => undefined,
		setPlanReferencePath: () => undefined,
		prompt: async (text: string) => {
			runtime.prompts.push(text);
		},
		sendCustomMessage: async (_message: unknown, options: unknown) => {
			runtime.messages.push({ options });
		},
	};
	const entry = { cwd, session } as unknown as SessionEntry;
	const methods = createPlanReviewMethods();
	installPlanReviewHandler(entry);
	const propose = () => runtime.proposal!("Ship it");
	const current = async () => (await methods.planGet!(entry, [{}])) as Dto;
	return { runtime, entry, methods, propose, current };
}

describe("plan review lifecycle", () => {
	test("a proposal opens a waiting review and refine resubmits through a revision turn", async () => {
		const { runtime, entry, methods, propose, current } = await fixture();
		await propose();
		expect(planReviewWaiting(entry)).toBe(true);
		const review = await current();
		const next = (await methods.planDecide!(entry, [
			{
				reviewId: review.reviewId,
				version: review.version,
				decision: "request_changes",
				note: "Split step one",
			},
		])) as Dto;
		expect(next.status).toBe("changes_requested");
		expect(runtime.messages[0]?.options).toEqual({ triggerTurn: true });
		expect(planReviewWaiting(entry)).toBe(false);
	});

	test("approve executes the reviewed plan and leaves plan mode", async () => {
		const { runtime, entry, methods, propose, current } = await fixture();
		runtime.planState = { enabled: true, planFilePath: "" };
		await propose();
		const review = await current();
		await methods.planDecide!(entry, [
			{ reviewId: review.reviewId, version: review.version, decision: "approve" },
		]);
		expect(runtime.prompts[0]).toContain("# Plan");
		expect(runtime.planState).toBeUndefined();
		expect(planReviewWaiting(entry)).toBe(false);
	});

	test("leaving plan mode dismisses a waiting review so nothing is stranded", async () => {
		const { runtime, entry, current, propose } = await fixture();
		runtime.planState = { enabled: true, planFilePath: "" };
		await propose();
		expect(planReviewWaiting(entry)).toBe(true);
		await exitPlanMode(entry);
		expect(planReviewWaiting(entry)).toBe(false);
		expect(runtime.planState).toBeUndefined();
		expect((await current()).status).toBe("dismissed");
	});

	test("a decision against a superseded version is refused as stale", async () => {
		const { entry, methods, propose, current } = await fixture();
		await propose();
		const review = await current();
		await expect(
			methods.planDecide!(entry, [
				{ reviewId: review.reviewId, version: review.version + 1, decision: "approve" },
			]),
		).rejects.toMatchObject({ code: "stale" });
	});
});

describe("plan decisions while the model works", () => {
	type Hooks = {
		sendCustomMessage: (message: unknown, options: unknown) => Promise<boolean>;
		emitNotice: (level: string, message: string, source: string) => void;
		abort: (args: unknown) => Promise<void>;
	};
	const hooks = (entry: SessionEntry) => entry.session as unknown as Hooks;

	test("refine answers while the revision turn is open, and the turn's resubmission lands", async () => {
		const { runtime, entry, methods, propose, current } = await fixture();
		await propose();
		const review = await current();
		const release = Promise.withResolvers<void>();
		const turnEnded = Promise.withResolvers<void>();
		// Like the SDK, the revision turn stays open until the model finishes. The model
		// resubmits through the proposal handler while that turn is still open.
		hooks(entry).sendCustomMessage = async (_message, options) => {
			runtime.messages.push({ options });
			await release.promise;
			await runtime.proposal!("Ship it, revised");
			turnEnded.resolve();
			return true;
		};
		const next = (await methods.planDecide!(entry, [
			{
				reviewId: review.reviewId,
				version: review.version,
				decision: "request_changes",
				note: "Split step one",
			},
		])) as Dto;
		expect(next.status).toBe("changes_requested");
		release.resolve();
		await turnEnded.promise;
		expect(planReviewWaiting(entry)).toBe(true);
	});

	test("a failing revision turn surfaces as a notice instead of failing the decision", async () => {
		const { runtime, entry, methods, propose, current } = await fixture();
		const noticed = Promise.withResolvers<string>();
		hooks(entry).emitNotice = (_level, message) => noticed.resolve(message);
		hooks(entry).sendCustomMessage = async () => {
			throw new Error("model unavailable");
		};
		await propose();
		const review = await current();
		const next = (await methods.planDecide!(entry, [
			{ reviewId: review.reviewId, version: review.version, decision: "request_changes" },
		])) as Dto;
		expect(next.status).toBe("changes_requested");
		expect(await noticed.promise).toBe("model unavailable");
		expect(runtime.prompts).toEqual([]);
	});
});
