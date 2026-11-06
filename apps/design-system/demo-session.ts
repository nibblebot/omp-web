import type { Model } from "@oh-my-pi/pi-ai";
import type { Effort } from "@oh-my-pi/pi-catalog/effort";
import type {
	ModelPresetDetail,
	ModelRoleCatalogEntry,
	PredictNextMessageReply,
	SessionListEntry,
} from "#lib/wire/protocol";
import type { ResumeCandidate } from "../web/store/resume";
import { setState, state } from "../web/state";
import { settleFiles, settleSessions, settleWorkspaceSessions } from "../web/store/roster";
import { addCalls, answerCommands, type CallHandlers } from "./session";
import { upsertRosterEntry } from "./fixtures/command-bus";
import { appSessions, appWorkspaceSessions } from "./fixtures/app-sessions";
import { daemonCommands, daemonsPatch } from "./fixtures/activities";
import { repoFiles, screenPredictions } from "./fixtures/composer";
import { btwCalls } from "./fixtures/dialogs";
import { extensionStateCalls } from "./fixtures/extensions";
import { jobCalls, screenJobDetails, screenJobTree } from "./fixtures/jobs";
import { browserEntries, fast, heavy, shared } from "./fixtures/models";
import { contextBreakdown, modelInfos, modelRoleCatalog, sessionTools } from "./fixtures/overlays";
import { projectCommands } from "./fixtures/roster-seed";
import { promptCacheFixture } from "./fixtures/prompt-cache";
import { newWorkspaceCommands } from "./fixtures/new-workspace";
import { SCREEN_WORKSPACE_ID, screenSubagents } from "./fixtures/screen";
import { sessionSettingsModel, settingsCalls } from "./fixtures/settings";
import {
	argRecord,
	screenAdvisorHistory,
	screenAdvisorOverview,
	screenSubagentTranscripts,
	screenSubagentWorkerRows,
	subagentCalls,
	transcriptPage,
} from "./fixtures/subagents";

/**
 * The demo's fake session (`bun run demo`): every call and command the App sends while a visitor
 * looks around is answered with fixture data, as a healthy session and fleet would answer it.
 * Answers follow the attached session: the screen session (`dmn_a002`) has the task call's two
 * scouts, their jobs, the dev server it left running and a todo board; the other sessions ran no
 * subagents. The fleet's daemons are listed, and their logs, restart and kill answered, as a
 * `daemons` frame would.
 * Writes the UI offers (model, thinking level, presets, roles, settings, extensions, the session
 * name) succeed and show in the store the way a session's state frame would show them.
 */

/** The browser's model rows, every one usable (the picker's locked-row state belongs to its story). */
const demoBrowserEntries = browserEntries.map(({ locked: _locked, ...entry }) => entry);

/**
 * The role catalog with every role on a model the browser lists, and the default role on no
 * `:level` suffix, so the default thinking level setting applies (the Settings row warns otherwise).
 */
const demoRoleCatalog: ModelRoleCatalogEntry[] = modelRoleCatalog.map((entry) => {
	if (entry.role === "default")
		return { ...entry, thinkingLevel: undefined, value: `${entry.provider}/${entry.id}` };
	if (entry.role === "slow")
		return {
			...entry,
			provider: "google",
			id: "gemini-3-pro",
			thinkingLevel: "high",
			value: "google/gemini-3-pro:high",
		};
	return entry;
});

/** The presets, `heavy` matching the demo's role catalog (its level comes from `defaultThinkingLevel`). */
const demoPresets: ModelPresetDetail[] = [
	{ ...heavy, modelRoles: { ...heavy.modelRoles, default: "anthropic/claude-opus-5-5" } },
	fast,
	shared,
];

/** Store fields a session's `state` frame carries that the screen seed leaves out. */
export const demoSessionState: Partial<typeof state> = {
	modelRoleCatalog: demoRoleCatalog,
	modelRoleStorage: "global",
	thinkingSelectors: ["off", "minimal", "low", "medium", "high", "xhigh"],
	modelPresets: { names: [fast.name, heavy.name, shared.name], active: heavy.name },
	autoCompactionEnabled: true,
	autoRetryEnabled: true,
	fastModeEnabled: false,
};

/** The session model a picker selector (`provider/id[:level]`) names, built on the current model. */
function modelFor(selector: string): { model: Model; level?: string } {
	const [ref = "", level] = selector.split(":");
	const [provider = "", id = ""] = ref.split("/");
	const entry = demoBrowserEntries.find(
		(row) => row.id === id && (provider === "" || row.provider === provider),
	);
	if (entry === undefined) throw new Error(`No model matches "${selector}"`);
	const base = state.model ?? appSessions[SCREEN_WORKSPACE_ID].view.model;
	if (base === undefined) throw new Error("No session model");
	return {
		model: {
			...base,
			id: entry.id,
			name: entry.id,
			provider: entry.provider,
			contextWindow: entry.contextWindow,
			reasoning: entry.reasoning,
			thinking: modelInfos.find((info) => info.provider === entry.provider && info.id === entry.id)
				?.thinking,
		},
		level,
	};
}

/** Model, thinking level, preset and role calls over one in-memory catalog. */
function modelCalls(): CallHandlers {
	const presets = new Map<string, ModelPresetDetail>(
		demoPresets.map((preset) => [preset.name, structuredClone(preset)]),
	);
	const publishPresets = (active = state.modelPresets?.active) =>
		setState("modelPresets", { names: [...presets.keys()].sort(), active });
	const setRole = (role: string, patch: Partial<ModelRoleCatalogEntry>) =>
		setState("modelRoleCatalog", (catalog) =>
			(catalog ?? []).map((entry) => (entry.role === role ? { ...entry, ...patch } : entry)),
		);
	const switchTo = (selector: string) => {
		const { model, level } = modelFor(selector);
		setState({ model, ...(level ? { thinkingLevel: level as Effort } : {}) });
		return { provider: model.provider, id: model.id, thinkingLevel: level };
	};
	return {
		getModelBrowser: () => demoBrowserEntries,
		getModelMentions: () => ({
			mentions: demoBrowserEntries
				.filter((entry) => entry.kind === "chat")
				.map((entry) => ({ provider: entry.provider, id: entry.id })),
		}),
		switchModel: (args) => switchTo(String(args[0])),
		setThinkingLevel: (args) => {
			setState("thinkingLevel", String(args[0]) as Effort);
			return undefined;
		},
		setTaskModel: (args) => {
			setState("taskModel", typeof args[0] === "string" ? args[0] : undefined);
			return undefined;
		},
		getModelPresets: () => {
			const names = [...presets.keys()].sort();
			return { names, active: state.modelPresets?.active, presets: [...presets.values()] };
		},
		applyModelPreset: (args) => {
			const preset = presets.get(String(args[0]));
			if (preset === undefined) throw new Error(`No preset named "${String(args[0])}"`);
			const selector = preset.modelRoles.default;
			if (selector) switchTo(selector);
			if (preset.defaultThinkingLevel)
				setState("thinkingLevel", preset.defaultThinkingLevel as Effort);
			publishPresets(preset.name);
			return { applied: preset.name, warnings: [] };
		},
		saveModelPreset: (args) => {
			const name = String(args[0]);
			const modelRoles = Object.fromEntries(
				(state.modelRoleCatalog ?? []).flatMap((entry) =>
					entry.value ? [[entry.role, entry.value]] : [],
				),
			);
			presets.set(name, { name, source: "global", modelRoles });
			publishPresets(name);
			return { message: `Saved preset "${name}".` };
		},
		deleteModelPreset: (args) => {
			const name = String(args[0]);
			if (!presets.delete(name)) return { result: "missing" };
			publishPresets(state.modelPresets?.active === name ? undefined : state.modelPresets?.active);
			return { result: "deleted" };
		},
		setModelRole: (args) => {
			const [role, provider, id, level] = args.map(String);
			setRole(role, {
				provider,
				id,
				thinkingLevel: args[3] === undefined ? undefined : level,
				value: `${provider}/${id}${args[3] === undefined ? "" : `:${level}`}`,
				source: "global",
			});
			return undefined;
		},
		clearModelRole: (args) => {
			setRole(String(args[0]), {
				provider: undefined,
				id: undefined,
				thinkingLevel: undefined,
				value: undefined,
				source: "default",
			});
			return undefined;
		},
		setModelRoleHidden: (args) => {
			setRole(String(args[0]), { hidden: args[1] === true });
			return undefined;
		},
	};
}

/** Subagent, worker and job answers for the attached session. */
function activityCalls(): CallHandlers {
	const screen = () => state.currentWorkspaceId === SCREEN_WORKSPACE_ID;
	const screenJobs = jobCalls({ tree: screenJobTree(), details: screenJobDetails });
	const noJobs = jobCalls({ tree: { rootId: "Main", rows: [] } });
	const jobs = () => (screen() ? screenJobs : noJobs);
	let advisorsOn = true;
	return {
		...subagentCalls(),
		getSubagents: () => (screen() ? structuredClone(screenSubagents) : []),
		workerList: () => (screen() ? structuredClone(screenSubagentWorkerRows) : []),
		getSubagentMessages: (args) => {
			const { subagentId, fromByte, maxBytes } = argRecord(args);
			const file = screen() ? screenSubagentTranscripts[String(subagentId)] : undefined;
			if (file === undefined) throw new Error(`No transcript for ${String(subagentId)}`);
			return transcriptPage(
				file,
				typeof fromByte === "number" ? fromByte : 0,
				typeof maxBytes === "number" ? maxBytes : Number.POSITIVE_INFINITY,
			);
		},
		workerPark: (args) => ({ id: String(args[0]), status: "parked", parked: true }),
		workerRevive: (args) => ({ id: String(args[0]), status: "idle" }),
		advisorGetStatus: (args) => {
			const section = argRecord(args).section;
			if (section === "warnings") return { warnings: [] };
			if (section === "stats") return screenAdvisorOverview.stats;
			return { ...screenAdvisorOverview.overview, active: advisorsOn };
		},
		advisorConfigure: (args) => {
			advisorsOn = argRecord(args).enabled !== false;
			return { enabled: advisorsOn, active: advisorsOn };
		},
		advisorTranscript: () => screenAdvisorHistory,
		getJobTree: (args) => jobs().getJobTree?.(args),
		getJobDetail: (args) => jobs().getJobDetail?.(args),
		cancelJob: (args) => jobs().cancelJob?.(args),
	};
}

/** Session-level calls: stats, the session name, toggles and a fresh session. */
function sessionCalls(): CallHandlers {
	return {
		getSessionStats: () => state.stats && { ...state.stats, contextUsage: state.contextUsage },
		getContextBreakdown: () => {
			const usage = state.contextUsage;
			if (!usage) return contextBreakdown;
			const fixed =
				contextBreakdown.systemPromptTokens +
				contextBreakdown.systemToolsTokens +
				contextBreakdown.systemContextTokens +
				contextBreakdown.skillsTokens;
			return {
				...contextBreakdown,
				contextWindow: usage.contextWindow,
				usedTokens: usage.tokens,
				messagesTokens: Math.max(0, (usage.tokens ?? 0) - fixed),
			};
		},
		getToolSchemas: () => sessionTools,
		getPromptCacheStatus: () => promptCacheFixture("warm"),
		getQueuedMessages: () => ({ steering: [], followUp: [] }),
		// A `/compact` sent with the follow-up key mid-turn: the demo has no compaction to run, so it is accepted and nothing queues.
		queueCompaction: () => undefined,
		setSessionName: (args) => {
			setState("sessionName", String(args[0]));
			return undefined;
		},
		setAutoCompaction: (args) => {
			setState("autoCompactionEnabled", args[0] === true);
			return undefined;
		},
		setAutoRetry: (args) => {
			setState("autoRetryEnabled", args[0] === true);
			return undefined;
		},
		setFastMode: (args) => {
			setState("fastModeEnabled", args[0] === true);
			return undefined;
		},
		newSession: () => {
			const dir = state.sessionFile?.slice(0, state.sessionFile.lastIndexOf("/"));
			const stamp = new Date().toISOString().slice(0, 19).replaceAll(":", "-");
			setState({
				sessionId: `sess_${crypto.randomUUID().slice(0, 6)}`,
				sessionName: undefined,
				sessionFile: dir === undefined ? undefined : `${dir}/${stamp}.jsonl`,
				items: [],
				todoPhases: [],
				messageCount: 0,
				stats: null,
				contextUsage: {
					tokens: 0,
					contextWindow: state.model?.contextWindow ?? 200_000,
					percent: 0,
				},
			});
			// The fleet's roster follows the session process onto its fresh session.
			const row = state.sessionRoster.find(
				(entry) => entry.workspaceId === state.currentWorkspaceId,
			);
			if (row !== undefined)
				upsertRosterEntry({
					...row,
					sessionTitle: undefined,
					sessionEmpty: true,
					lastSessionFile: state.sessionFile,
				});
			return { cancelled: false };
		},
		predictWord: () => null,
		predictWordFeedback: () => undefined,
		predictNextMessage: (): PredictNextMessageReply => ({
			text: screenPredictions[0]!,
			choices: [...screenPredictions],
		}),
		predictionShown: () => ({}),
		predictionAccepted: () => ({}),
	};
}

/** Sessions the palette and `/resume` list: every App view session, newest first. */
function allSessions(): SessionListEntry[] {
	return Object.keys(appSessions)
		.flatMap((workspaceId) => appWorkspaceSessions(workspaceId))
		.sort((a, b) => b.modifiedAt - a.modifiedAt);
}

/**
 * `resumeList` over every App view session (the palette and the resume picker): a title, file or
 * first-prompt match on the query; sessions of the attached session's project are local. The
 * `phase` argument (preliminary or complete) is answered alike, with the whole list.
 */
function resumeCalls(): CallHandlers {
	return {
		resumeList: (args) => {
			const { query, limit, allProjects } = argRecord(args);
			const needle = typeof query === "string" ? query.trim().toLowerCase() : "";
			const projectOf = (workspaceId: string) =>
				state.sessionRoster.find((row) => row.workspaceId === workspaceId)?.projectId;
			const current = projectOf(state.currentWorkspaceId);
			const candidates: ResumeCandidate[] = Object.keys(appSessions).flatMap((workspaceId) => {
				const prompt = appSessions[workspaceId]?.items.find((item) => item.kind === "user");
				return appWorkspaceSessions(workspaceId).map((entry): ResumeCandidate => ({
					id: entry.id,
					sessionFile: entry.path,
					cwd: entry.cwd,
					title: entry.name,
					createdMs: entry.modifiedAt,
					modifiedMs: entry.modifiedAt,
					messageCount: entry.messageCount ?? 0,
					firstMessage: prompt?.kind === "user" ? prompt.text : undefined,
					pinned: false,
					scope: projectOf(workspaceId) === current ? "local" : "global",
				}));
			});
			const hits = candidates
				.filter((c) => allProjects === true || c.scope === "local")
				.filter(
					(c) =>
						needle === "" ||
						[c.title, c.firstMessage, c.sessionFile, c.id].some((text) =>
							text?.toLowerCase().includes(needle),
						),
				)
				.sort((a, b) => b.modifiedMs - a.modifiedMs);
			return {
				candidates: hits.slice(0, typeof limit === "number" ? limit : hits.length),
				pinnedIds: [],
				sessionDir: "/home/joshua/.omp/sessions",
				total: hits.length,
				allProjects: allProjects === true,
				// Every phase answers the whole list: the demo has no scan to wait for.
				complete: true,
			};
		},
	};
}

/** Install the demo's answers; call after `answerCannedTurns` (its `answerCalls` replaces the set). */
export function answerDemoSession(): void {
	addCalls({
		...activityCalls(),
		...btwCalls(),
		...settingsCalls(sessionSettingsModel()),
		...modelCalls(),
		...extensionStateCalls(),
		...sessionCalls(),
		...resumeCalls(),
	});
	answerCommands({
		...projectCommands,
		...daemonCommands(),
		...newWorkspaceCommands({ start: true }),
		list_workspace_sessions: (cmd) => {
			if (cmd.type === "list_workspace_sessions")
				settleWorkspaceSessions(cmd.workspaceId, appWorkspaceSessions(cmd.workspaceId), cmd.limit);
		},
		list_sessions: (cmd) => {
			if (cmd.type === "list_sessions") settleSessions(cmd.id, allSessions());
		},
		list_files: (cmd) => {
			if (cmd.type !== "list_files") return;
			const query = cmd.query.toLowerCase();
			const hits = repoFiles.filter((path) => path.toLowerCase().includes(query));
			settleFiles(cmd.id, hits.slice(0, cmd.limit ?? 50));
		},
	});
	setState({ ...structuredClone(demoSessionState), ...daemonsPatch() });
}
