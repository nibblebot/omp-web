/**
 * Server capability advertisement (C02/C06). The daemon tells the browser which
 * consumer domains it can actually serve, via `WebSessionState.capabilities` on
 * the attach priming and every state frame.
 *
 * A key is advertised only when EVERY method for that domain is a dispatchable
 * function in the live web-method table, so the advertisement cannot drift from
 * `methods.ts`. Absent means unavailable on the wire.
 *
 * Keys deliberately left absent:
 * - integrations: `getIntegrationsState` and `getSkillsState` are placeholders
 *   (empty servers, "extraction has not landed").
 * - browserUi: its shape is `BrowserUiCapabilities`, not `Capability`.
 *
 * Git additionally carries a runtime verdict: the review service binds to the
 * session cwd, so a cwd outside any repository advertises `available: false`
 * with the reason instead of a panel that fails on first use.
 */

import { git } from "@oh-my-pi/pi-natives/vcs";
import type { Capability, ServerCapabilities, WebMethodName } from "#lib/wire/protocol";

/** Every method a domain's consumers invoke; all must be dispatchable. */
const REQUIRED_METHODS = {
	git: [
		"gitStatus",
		"gitStage",
		"gitUnstage",
		"gitStageHunks",
		"gitCommit",
		"gitFileDiff",
		"gitUnstagedPatch",
	],
	review: [
		"annotationList",
		"annotationCreate",
		"annotationUpdate",
		"annotationRemove",
		"annotationReanchor",
		"annotationCompose",
	],
	graph: ["getSessionGraph", "navigateTree", "resumeAfterAskReanswer"],
	planReview: ["planGet", "planDecide", "planReopen", "planCancel"],
	todos: ["todoGet", "todoApply", "todoImport", "todoExport"],
	workerLifecycle: ["workerList", "workerPark", "workerRevive", "workerResume"],
	advisor: ["advisorGetStatus", "advisorConfigure", "advisorTranscript"],
	goals: ["goalCreate", "goalReplace", "goalBudget", "goalPause", "goalResume", "goalDrop"],
	loops: ["loopPreview", "loopPolicy", "loopStart", "loopPause", "loopCancel", "loopResume"],
	modelPresets: ["getModelPresets", "saveModelPreset", "applyModelPreset", "deleteModelPreset"],
	temporaryModel: ["switchModel"],
	modelMentions: ["getModelMentions"],
	vibe: [
		"vibeStatus",
		"vibeSetMode",
		"vibeSpawn",
		"vibeSend",
		"vibeWait",
		"vibeKill",
		"vibeKillAll",
		"vibeRehydrate",
	],
	btwHistory: [
		"btwList",
		"btwSearch",
		"btwPage",
		"btwStart",
		"btwFollowUp",
		"btwCancel",
		"btwCopy",
		"btwPromotePreview",
		"btwPromote",
	],
	downloads: ["downloadManifest", "exportDownload", "dumpSessionArchive"],
	resumeImport: [
		"getResumeCapabilities",
		"resumeResolve",
		"resumeList",
		"resumePinToggle",
		"resumeRename",
		"resumeDelete",
		"foreignList",
		"foreignPreview",
		"foreignImport",
		"foreignUploadStage",
		"foreignUploadCancel",
		"lineageResume",
	],
} as const satisfies Record<string, readonly WebMethodName[]>;

/** Opens the repository bound to `cwd`, or null when none is discoverable. */
export type OpenRepo = (cwd: string) => unknown;

/** Runtime verdict for the git review service bound to `cwd`. */
export function gitCapability(cwd: string, openRepo: OpenRepo = git): Capability {
	try {
		if (openRepo(cwd)) return { available: true };
		return { available: false, reason: `not a git repository: ${cwd}` };
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return { available: false, reason: `git repository unavailable: ${detail}` };
	}
}

export interface CapabilityInputs {
	/** The live web-method table; a key is advertised only if all its methods are present. */
	methods: Readonly<Record<string, unknown>>;
	/** Session cwd the review services bind to. */
	cwd: string;
	/** Test seam for repository discovery. */
	openRepo?: OpenRepo;
}

/** Build the capability map the daemon advertises for one session. */
export function buildServerCapabilities(inputs: CapabilityInputs): ServerCapabilities {
	const capabilities: ServerCapabilities = {};
	for (const [key, names] of Object.entries(REQUIRED_METHODS)) {
		if (names.some((name) => typeof inputs.methods[name] !== "function")) continue;
		capabilities[key] =
			key === "git" ? gitCapability(inputs.cwd, inputs.openRepo) : { available: true };
	}
	return capabilities;
}
