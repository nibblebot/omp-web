import { createHash, randomUUID } from "node:crypto";
import { readPlanFile } from "@oh-my-pi/pi-coding-agent/plan-mode/plan-files";
import type { PlanApprovalDetails } from "@oh-my-pi/pi-coding-agent/plan-mode/approved-plan";
import type { PlanReviewDto } from "../../lib/wire/protocol";
import { listReviewAnnotations } from "./review-annotations";
import type { SessionEntry } from "./session-entry";

const CUSTOM_TYPE = "web_plan_review";
type Review = PlanReviewDto & {
	content: string;
	executionRole: string;
	context: "preserve" | "reset";
	note?: string;
};
type Runtime = {
	enabled: string[];
	mounted: string[];
	stopPending: boolean;
	tail: Promise<unknown>;
};
const runtimes = new WeakMap<SessionEntry, Runtime>();

function fail(code: "stale" | "not_eligible", message: string): never {
	throw Object.assign(new Error(message), { code });
}
function hash(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}
function latest(entry: SessionEntry): Review | null {
	const branch = entry.session.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const item = branch[i];
		if (item.type === "custom" && item.customType === CUSTOM_TYPE) return item.data as Review;
	}
	return null;
}
async function persist(entry: SessionEntry, review: Review): Promise<void> {
	entry.session.sessionManager.appendCustomEntry(CUSTOM_TYPE, review);
	await entry.session.sessionManager.flush();
}
function runtime(entry: SessionEntry): Runtime {
	const state = runtimes.get(entry);
	if (!state) fail("not_eligible", "Plan review handler is not installed");
	return state;
}
function serialized<T>(entry: SessionEntry, action: () => Promise<T>): Promise<T> {
	const state = runtime(entry);
	const result = state.tail.then(action);
	state.tail = result.catch(() => undefined);
	return result;
}
async function readDraft(entry: SessionEntry, path: string): Promise<string> {
	const manager = entry.session.sessionManager;
	const content = await readPlanFile(path, {
		cwd: entry.cwd,
		localProtocolOptions: {
			getArtifactsDir: () => manager.getArtifactsDir(),
			getSessionId: () => manager.getSessionId(),
		},
	});
	if (content === null || !content.trim()) fail("not_eligible", "Plan draft is missing or empty");
	return content;
}
async function refresh(entry: SessionEntry, review: Review): Promise<Review> {
	const content = await readDraft(entry, review.planFilePath);
	const contentHash = hash(content);
	if (review.contentHash === contentHash) return review;
	const changed = { ...review, content, contentHash, version: review.version + 1 };
	await persist(entry, changed);
	return changed;
}
async function dto(entry: SessionEntry, review: Review | null): Promise<Review | null> {
	if (!review) return null;
	return { ...review, annotations: await listReviewAnnotations(entry, "plan") };
}
function input(args: unknown[]): Record<string, unknown> {
	const value = args[0];
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Plan request must be an object");
	return value as Record<string, unknown>;
}
function requireReview(entry: SessionEntry, id: unknown): Review {
	const review = latest(entry);
	if (!review || review.reviewId !== id) fail("stale", "Plan review is no longer current");
	return review;
}

/** Install before entering plan mode, while the execution tool presentation is still active.
 * Unsubscribe only on session disposal, never on browser disconnect. */
export function installPlanReviewHandler(entry: SessionEntry): () => void {
	if (runtimes.has(entry)) fail("not_eligible", "Plan review handler is already installed");
	const session = entry.session;
	const state: Runtime = {
		enabled: session.getEnabledToolNames().filter((name) => !name.startsWith("mcp__")),
		mounted: session.getMountedXdevToolNames().filter((name) => !name.startsWith("mcp__")),
		stopPending: false,
		tail: Promise.resolve(),
	};
	runtimes.set(entry, state);
	session.setPlanProposalHandler((title) =>
		serialized(entry, async () => {
			const prepared = await session.preparePlanForReview(title);
			if (!prepared.details)
				throw fail("not_eligible", "Plan preparation produced no reviewable draft");
			const details: PlanApprovalDetails = prepared.details;
			const content = await readDraft(entry, details.planFilePath);
			const previous = latest(entry);
			const review: Review = {
				reviewId: previous?.status === "waiting" ? previous.reviewId : randomUUID(),
				planFilePath: details.planFilePath,
				title: details.title,
				content,
				contentHash: hash(content),
				version: previous?.status === "waiting" ? previous.version + 1 : 1,
				status: "waiting",
				executionRole: "exec",
				context: "preserve",
			};
			const plan = session.getPlanModeState();
			if (plan) session.setPlanModeState({ ...plan, planFilePath: details.planFilePath });
			await persist(entry, review);
			state.stopPending = true;
			return {
				content: [
					{
						type: "text" as const,
						text: "Plan submitted. Wait for the operator's review; do not execute it.",
					},
				],
				details,
			};
		}),
	);
	const unsubscribe = session.subscribe((event) => {
		if (event.type !== "tool_execution_end" || !state.stopPending) return;
		state.stopPending = false;
		session.markPlanInternalAbortPending();
		void session
			.abort({ reason: "planning-turn-end", goalReason: "internal" })
			.catch((error) => {
				session.emitNotice(
					"error",
					error instanceof Error ? error.message : String(error),
					"plan-review",
				);
			})
			.finally(() => session.clearPlanInternalAbortPending());
	});
	return () => {
		unsubscribe();
		session.setPlanProposalHandler(null);
		runtimes.delete(entry);
	};
}

/** Explicit host lifecycle hook. Natural planning completion keeps the durable wait.
 * Call operator-cancel for an operator abort, not connection loss or internal aborts. */
export async function handlePlanReviewTurnEnd(
	entry: SessionEntry,
	reason: "planning-turn-end" | "operator-cancel",
): Promise<void> {
	if (reason === "planning-turn-end") return;
	await serialized(entry, async () => {
		const review = latest(entry);
		if (review?.status === "waiting") await persist(entry, { ...review, status: "dismissed" });
		runtime(entry).stopPending = false;
	});
}

export function createPlanReviewMethods(): Record<
	string,
	(entry: SessionEntry, args: unknown[]) => Promise<unknown>
> {
	return {
		planGet: (entry, args) =>
			serialized(entry, async () => {
				input(args);
				const review = latest(entry);
				return dto(entry, review?.status === "waiting" ? await refresh(entry, review) : review);
			}),
		planDecide: (entry, args) =>
			serialized(entry, async () => {
				const request = input(args);
				let review = requireReview(entry, request.reviewId);
				if (review.status !== "waiting") fail("not_eligible", "Plan is not waiting for a decision");
				review = await refresh(entry, review);
				if (request.version !== review.version)
					fail("stale", "Plan draft changed; review the current version");
				if (
					request.decision !== "approve" &&
					request.decision !== "request_changes" &&
					request.decision !== "dismiss"
				)
					throw new Error("Invalid plan decision");
				if (request.note !== undefined && typeof request.note !== "string")
					throw new Error("Plan note must be a string");
				if (
					request.context !== undefined &&
					request.context !== "preserve" &&
					request.context !== "reset"
				)
					throw new Error("Invalid plan context");
				if (
					request.executionRole !== undefined &&
					(typeof request.executionRole !== "string" || !request.executionRole.trim())
				)
					throw new Error("Invalid execution role");
				const decision = request.decision;
				const next: Review = {
					...review,
					status:
						decision === "approve"
							? "approved"
							: decision === "request_changes"
								? "changes_requested"
								: "dismissed",
					...(request.note !== undefined ? { note: request.note as string } : {}),
					executionRole: (request.executionRole as string | undefined) ?? review.executionRole,
					context: (request.context as Review["context"] | undefined) ?? review.context,
				};
				const session = entry.session;
				if (decision === "approve") {
					if (session.isStreaming || session.hasAdmittedSubmission || session.hasPostPromptWork)
						fail("not_eligible", "Wait for the planning turn to finish before approving");
					const role = session.getRoleModelCycle([next.executionRole])?.models[0];
					if (request.executionRole !== undefined && !role)
						fail("not_eligible", "Execution role is not configured");
					await session.runModeExitTeardown(async () => {
						const state = runtime(entry);
						await session.restoreNonMCPToolPresentation(state.enabled, state.mounted);
						session.setPlanModeState(undefined);
						if (role) await session.applyRoleModel(role);
						if (next.context === "reset") await session.resetSessionContext();
						session.setPlanReferencePath(next.planFilePath);
						session.sessionManager.appendModeChange("none");
						await persist(entry, next);
					});
					void session
						.prompt(
							`The operator approved the following plan. Execute it step by step and verify the implementation. Durable plan: ${next.planFilePath}\n\n${next.content}`,
							{
								synthetic: true,
								userInitiated: true,
								expandPromptTemplates: false,
								runCommands: false,
								throwOnDrop: true,
							},
						)
						.catch((error) =>
							session.emitNotice(
								"error",
								error instanceof Error ? error.message : String(error),
								"plan-review",
							),
						);
				} else {
					await persist(entry, next);
					if (decision === "request_changes") {
						await session.sendCustomMessage(
							{
								customType: "plan_review_feedback",
								content: `Plan changes requested.${next.note ? `\n${next.note}` : ""}`,
								display: true,
							},
							{ triggerTurn: false },
						);
					}
				}
				return dto(entry, next);
			}),
		planReopen: (entry, args) =>
			serialized(entry, async () => {
				const review = requireReview(entry, input(args).reviewId);
				if (review.status === "approved")
					fail("not_eligible", "An approved plan cannot be reopened");
				const updated = await refresh(entry, review);
				const next: Review = { ...updated, status: "waiting" };
				entry.session.setPlanModeState({
					...(entry.session.getPlanModeState() ?? {}),
					enabled: true,
					planFilePath: next.planFilePath,
				});
				entry.session.sessionManager.appendModeChange("plan", { planFilePath: next.planFilePath });
				await persist(entry, next);
				return dto(entry, next);
			}),
		planCancel: async (entry, args) => {
			const request = input(args);
			return serialized(entry, async () => {
				const review = requireReview(entry, request.reviewId);
				if (review.status !== "waiting") fail("not_eligible", "Plan is not waiting for review");
				runtime(entry).stopPending = false;
				const next: Review = { ...review, status: "dismissed" };
				await persist(entry, next);
				await entry.session.abort({ reason: "operator-cancel" });
				return dto(entry, next);
			});
		},
	};
}
