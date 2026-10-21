/**
 * Command palette store adapter: reads the live stores into `PaletteSources`,
 * runs the chosen item's action, and keeps the recent picks. Ranking and
 * grouping live in `palette/palette.ts`.
 */
import { isFeatureEnabled } from "../features/registry";
import { filterWebUiSettings } from "../prefs/settings";
import { visibleSettingsTabs } from "../prefs/settings-tabs";
import {
	modelItems,
	openItems,
	type PaletteItem,
	type PaletteSources,
	rosterSessionItems,
	settingItems,
	storedSessionItems,
} from "../palette/palette";
import { commandUsage, currentCommandRegistry, dispatchInput } from "../prompt/commands";
import { hasLiveSession, setState, state } from "../state";
import { openDock } from "./dock";
import { setPromptInsert } from "./chat";
import { openModelPicker, recentModels, switchSessionModel } from "./models";
import { openAddProject, openNewWorkspace } from "./projects";
import { chooseResumeTarget, searchAllProjectSessions, sessionRowsFromResume } from "./resume";
import { switchToDaemon } from "./roster";
import { reportError } from "./toasts";

const RECENTS_KEY = "omp-web:palette-recents";
const RECENTS_MAX = 8;

/** Ids of the items the user picked, newest first. */
export function paletteRecents(): string[] {
	if (typeof localStorage === "undefined") return [];
	try {
		const raw: unknown = JSON.parse(localStorage.getItem(RECENTS_KEY) ?? "[]");
		if (!Array.isArray(raw)) return [];
		return raw.filter((id): id is string => typeof id === "string").slice(0, RECENTS_MAX);
	} catch {
		return [];
	}
}

function recordRecent(id: string): void {
	if (typeof localStorage === "undefined") return;
	const next = [id, ...paletteRecents().filter((x) => x !== id)].slice(0, RECENTS_MAX);
	localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
}

/** Every source the palette ranks, built from the live stores. `stored` is the server session search result. */
export function paletteSources(query: string, stored: readonly PaletteItem[]): PaletteSources {
	const webRows = filterWebUiSettings(query, {
		sessionAttached: hasLiveSession(),
		signedIn: state.authStatus === "signedIn",
	});
	return {
		commands: { registry: currentCommandRegistry(), usage: commandUsage(), live: state },
		open: openItems({
			debugEnabled: isFeatureEnabled("debug"),
			projects: state.registeredProjects,
		}),
		sessions: [...rosterSessionItems(state.daemonRoster, state.currentSessionId), ...stored],
		settings: settingItems(state.settingsModel, visibleSettingsTabs(state.settingsModel), webRows),
		models: modelItems(
			state.modelBrowser ?? null,
			recentModels(),
			state.model ? `${state.model.provider}/${state.model.id}` : undefined,
			query.trim() !== "",
		),
		recents: paletteRecents(),
	};
}

/** Stored sessions in every project matching `query`, as palette items. */
export async function searchStoredSessions(query: string): Promise<PaletteItem[]> {
	const candidates = await searchAllProjectSessions(query);
	const covered = new Set(
		state.daemonRoster.flatMap((d) => (d.lastSessionFile ? [d.lastSessionFile] : [])),
	);
	return storedSessionItems(
		sessionRowsFromResume(candidates, state.sessionFile),
		Date.now(),
		covered,
	);
}

/** Run an item: close the palette, record the pick, then do its action. */
export function runPaletteItem(item: PaletteItem): void {
	recordRecent(item.id);
	setState("modal", null);
	const action = item.action;
	switch (action.kind) {
		case "command":
			if (action.fill) setPromptInsert({ text: action.text });
			else dispatchInput(action.text, undefined, "enter");
			return;
		case "daemon-session": {
			// The attached session is a no-op, unless its process is stopped (a UI stop keeps
			// the view on it): then the pick wakes it and attaches again.
			void switchToDaemon(action.daemonId);
			return;
		}
		case "stored-session":
			void chooseResumeTarget(action.sessionId).catch(reportError);
			return;
		case "setting":
			setState("settingsTab", action.tabId);
			setState("settingsQuery", action.query ?? "");
			setState("modal", "settings");
			return;
		case "model":
			void switchSessionModel(action.selector);
			return;
		case "model-picker":
			openModelPicker();
			return;
		case "open":
			if (action.target === "add-project") {
				openAddProject();
				return;
			}
			if (action.target === "subagents") {
				openDock("agents");
				return;
			}
			setState("modal", action.target);
			return;
		case "new-workspace":
			openNewWorkspace(action.projectId);
			return;
	}
}
