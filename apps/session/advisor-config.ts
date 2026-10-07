import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { type } from "@oh-my-pi/omptype";
import {
	discoverAdvisorConfigs,
	loadWatchdogConfigFile,
	resolveAdvisorConfigEditPath,
	saveWatchdogConfigFile,
	type AdvisorReviewMode,
	type AdvisorSyncBacklog,
} from "@oh-my-pi/pi-coding-agent/advisor/config";
import {
	cfgAdvisorEnabled,
	cfgAdvisorEvictStaleResults,
	cfgAdvisorImmuneTurns,
	cfgAdvisorMaxNotesPerUpdate,
	cfgAdvisorReviewInterval,
	cfgAdvisorReviewMode,
	cfgAdvisorSyncBacklog,
} from "@oh-my-pi/pi-coding-agent/advisor/settings";
import type {
	AdvisorConfig,
	AdvisorConfigScope,
	WatchdogConfigDoc,
} from "@oh-my-pi/pi-tui/overlays/advisor-config";
import type { SessionEntry } from "./session-entry";

export type { AdvisorConfig, AdvisorConfigScope, WatchdogConfigDoc };

/** Effective SDK settings, not a claim that a running advisor exists. */
export interface AdvisorSettingsDto {
	enabled: boolean;
	syncBacklog: AdvisorSyncBacklog;
	immuneTurns: number;
	reviewMode: AdvisorReviewMode;
	reviewInterval: number;
	maxNotesPerUpdate: number;
	evictStaleResults: boolean;
}

export interface AdvisorConfigurationDto {
	scope: AdvisorConfigScope;
	/** Raw, unmerged and unexpanded file contents, exactly as in the SDK editor. */
	document: WatchdogConfigDoc;
	settings: AdvisorSettingsDto;
	/** A session-only toggle can differ from the persisted/effective setting. */
	runtime: { enabled: boolean; active: boolean };
	availableToolNames: string[];
	discoveryWarnings: string[];
}

export interface AdvisorConfigurationUpdate {
	scope: AdvisorConfigScope;
	document: WatchdogConfigDoc;
}

// SDK parseWatchdogDoc/advisorEntrySchema are private (advisor/config.ts:61-117).
// Match that input vocabulary here, but reject malformed browser requests BEFORE
// saving rather than relying on discovery to drop broken entries after mutation.
// The public SDK writer retains ownership of normalization and serialization.
const documentSchema = type({
	"instructions?": "string",
	"maxNotesPerUpdate?": "number",
	advisors: type({
		name: "string",
		"model?": "string",
		"tools?": "string[]",
		"reviewMode?": "'turn' | 'agent-end'",
		"reviewInterval?": "1 <= number.integer <= 9007199254740991",
		"syncBacklog?": "'off' | '1' | '3' | '5' | 'strict'",
		"instructions?": "string",
		"enabled?": "boolean",
		"maxNotesPerUpdate?": "number",
	}).array(),
	"warnings?": "string[]",
});

const settingHandles = {
	enabled: cfgAdvisorEnabled,
	syncBacklog: cfgAdvisorSyncBacklog,
	immuneTurns: cfgAdvisorImmuneTurns,
	reviewMode: cfgAdvisorReviewMode,
	reviewInterval: cfgAdvisorReviewInterval,
	maxNotesPerUpdate: cfgAdvisorMaxNotesPerUpdate,
	evictStaleResults: cfgAdvisorEvictStaleResults,
};

function assertScope(scope: AdvisorConfigScope): void {
	if (scope !== "project" && scope !== "user")
		throw new Error("Invalid advisor configuration scope");
}

function configDirectories(entry: SessionEntry): {
	projectDir: string;
	agentDir: string;
	cwd: string;
} {
	const cwd = entry.session.sessionManager.getCwd();
	let projectDir = cwd;
	try {
		projectDir = vcs.repo(cwd)?.root() ?? cwd;
	} catch {
		// Same non-repository fallback as SDK showAdvisorConfigure.
	}
	return { cwd, projectDir, agentDir: entry.session.settings.getAgentDir() };
}

export function getAdvisorSettings(entry: SessionEntry): AdvisorSettingsDto {
	return {
		enabled: cfgAdvisorEnabled.get(entry.session),
		syncBacklog: cfgAdvisorSyncBacklog.get(entry.session),
		immuneTurns: cfgAdvisorImmuneTurns.get(entry.session),
		reviewMode: cfgAdvisorReviewMode.get(entry.session),
		reviewInterval: cfgAdvisorReviewInterval.get(entry.session),
		maxNotesPerUpdate: cfgAdvisorMaxNotesPerUpdate.get(entry.session),
		evictStaleResults: cfgAdvisorEvictStaleResults.get(entry.session),
	};
}

/** Persist global settings through the SDK; its registered listeners own live effects. */
export async function setAdvisorSettings(
	entry: SessionEntry,
	patch: Partial<AdvisorSettingsDto>,
): Promise<AdvisorSettingsDto> {
	if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
		throw new Error("Advisor settings must be an object");
	}
	// Validate the whole patch before the first mutation using public SDK validators.
	for (const [key, value] of Object.entries(patch)) {
		if (!Object.hasOwn(settingHandles, key)) throw new Error(`Unknown advisor setting: ${key}`);
		settingHandles[key as keyof AdvisorSettingsDto].assertWritable(value);
	}
	if (patch.enabled !== undefined) cfgAdvisorEnabled.set(entry.session, patch.enabled);
	if (patch.syncBacklog !== undefined) cfgAdvisorSyncBacklog.set(entry.session, patch.syncBacklog);
	if (patch.immuneTurns !== undefined) cfgAdvisorImmuneTurns.set(entry.session, patch.immuneTurns);
	if (patch.reviewMode !== undefined) cfgAdvisorReviewMode.set(entry.session, patch.reviewMode);
	if (patch.reviewInterval !== undefined)
		cfgAdvisorReviewInterval.set(entry.session, patch.reviewInterval);
	if (patch.maxNotesPerUpdate !== undefined)
		cfgAdvisorMaxNotesPerUpdate.set(entry.session, patch.maxNotesPerUpdate);
	if (patch.evictStaleResults !== undefined)
		cfgAdvisorEvictStaleResults.set(entry.session, patch.evictStaleResults);
	await entry.session.settings.flush();
	return getAdvisorSettings(entry);
}

export async function getAdvisorConfiguration(
	entry: SessionEntry,
	scope: AdvisorConfigScope = "project",
): Promise<AdvisorConfigurationDto> {
	assertScope(scope);
	const dirs = configDirectories(entry);
	const [document, discovered] = await Promise.all([
		loadWatchdogConfigFile(await resolveAdvisorConfigEditPath(scope, dirs)),
		discoverAdvisorConfigs(dirs.cwd, dirs.agentDir),
	]);
	return {
		scope,
		document,
		settings: getAdvisorSettings(entry),
		runtime: { enabled: entry.session.isAdvisorEnabled(), active: entry.session.isAdvisorActive() },
		availableToolNames: entry.session.getAdvisorAvailableToolNames(),
		discoveryWarnings: discovered.warnings,
	};
}

/** Headless extraction of SDK showAdvisorConfigure's save callback, not a raw Agent mutation. */
export async function setAdvisorConfiguration(
	entry: SessionEntry,
	update: AdvisorConfigurationUpdate,
): Promise<AdvisorConfigurationDto> {
	if (!update || typeof update !== "object")
		throw new Error("Advisor configuration must be an object");
	assertScope(update.scope);
	documentSchema.assert(update.document);
	const dirs = configDirectories(entry);
	await saveWatchdogConfigFile(
		await resolveAdvisorConfigEditPath(update.scope, dirs),
		update.document,
	);
	// Apply the merged user/project roster, never just the file being edited.
	const discovered = await discoverAdvisorConfigs(dirs.cwd, dirs.agentDir);
	entry.session.applyAdvisorConfigs(
		discovered.advisors,
		discovered.sharedInstructions,
		discovered.sharedMaxNotesPerUpdate,
	);
	// Do not activate a disabled session. SDK applyAdvisorConfigs stores the new
	// roster for the next enable and rebuilds only according to its own live state.
	return getAdvisorConfiguration(entry, update.scope);
}
