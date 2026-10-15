import { createSignal, For, Show } from "solid-js";
import { appearanceWebImages } from "../../prefs/settings";
import { authSnapshot, signOut } from "../../store/auth";
import {
	call,
	fleetSettingsActive,
	setNotifyEnabled,
	setSidebarUsage,
	setState,
	state,
} from "../../state";
import { MinusIcon, PlusIcon } from "../ui/icons";
import {
	currentFontSize,
	currentThemePreference,
	setTheme,
	stepFontSize,
	THEME_OPTIONS,
	type ThemePreference,
} from "../../prefs/theme";
import type { SettingsModel } from "#lib/wire/protocol";
import { SettingsRowLayout, SettingsRow } from "./SettingsRow";

/**
 * "Web UI" section body. Three state sources with intentionally separate
 * update paths (never merged):
 * - client-local (localStorage-backed): theme preference + font size, via
 *   theme.ts; the local signals are seeded from the persisted values. The
 *   usage-in-sidebar visibility toggle is also localStorage-backed
 *   ("omp.sidebarUsage") but flows through the store facade
 *   (state.sidebarUsage / setSidebarUsage), not a local signal;
 * - server model (refreshSettings/updateSetting): the Images group's
 *   images.* items, rendered through SettingsRow;
 * - session-scoped: the soften store toggle and the fast-mode /
 *   auto-retry RPC calls (hidden under the fleet fallback, mirroring their
 *   main-UI session scope).
 * The shell gates which section renders; the sidebar group filter (null =
 * all groups) comes in as a prop.
 */
export function WebUiSettings(props: { model: SettingsModel; visibleGroup: string | null }) {
	// Client-local theme/font-size (localStorage via theme.ts).
	const [theme, setThemeSignal] = createSignal<ThemePreference>(currentThemePreference());
	const [fontSize, setFontSize] = createSignal(currentFontSize());

	return (
		<>
			<Show when={props.visibleGroup === null || props.visibleGroup === "Interface"}>
				<div class="settings-group">
					<h3 class="settings-group-title">Interface</h3>
					<SettingsRowLayout label="theme preference">
						<select
							aria-label="theme preference"
							value={theme()}
							onChange={(e) => setThemeSignal(setTheme(e.currentTarget.value as ThemePreference))}
						>
							<For each={THEME_OPTIONS}>{(o) => <option value={o.id}>{o.label}</option>}</For>
						</select>
					</SettingsRowLayout>
					<SettingsRowLayout label="font size">
						<div class="settings-font">
							<button
								type="button"
								class="settings-control-btn"
								aria-label="Decrease font size"
								onClick={() => setFontSize(stepFontSize(-1))}
							>
								<MinusIcon />
							</button>
							<span class="settings-font-value">{fontSize()}</span>
							<button
								type="button"
								class="settings-control-btn"
								aria-label="Increase font size"
								onClick={() => setFontSize(stepFontSize(1))}
							>
								<PlusIcon />
							</button>
						</div>
					</SettingsRowLayout>
					{/* Client-local store toggles (setNotifyEnabled persists to
					    localStorage as well; soften is a UI pref). */}
					<SettingsRowLayout
						label="browser notification permission"
						description="Grants this browser permission to show OS notifications while the tab is hidden. Which events notify is set by Completion, Error and Ask Notification."
					>
						<input
							type="checkbox"
							aria-label="browser notification permission"
							checked={state.notifyEnabled}
							onChange={(e) => setNotifyEnabled(e.currentTarget.checked)}
						/>
					</SettingsRowLayout>
					<SettingsRowLayout label="soft fade">
						<input
							type="checkbox"
							aria-label="soft fade"
							checked={state.soften}
							onChange={(e) => setState("soften", e.currentTarget.checked)}
						/>
					</SettingsRowLayout>
					<SettingsRowLayout label="usage in sidebar">
						<input
							type="checkbox"
							aria-label="usage in sidebar"
							checked={state.sidebarUsage}
							onChange={(e) => setSidebarUsage(e.currentTarget.checked)}
						/>
					</SettingsRowLayout>
					{/* Session-RPC rows: no live session under the fleet fallback, so they
					    would only error. They stay hidden, mirroring their main-UI session
					    scope. */}
					<Show when={!fleetSettingsActive()}>
						<SettingsRowLayout label="fast mode">
							<input
								type="checkbox"
								aria-label="fast mode"
								checked={state.fastModeEnabled}
								onChange={(e) =>
									void call("setFastMode", [e.currentTarget.checked]).catch((err) =>
										setState("error", String(err)),
									)
								}
							/>
						</SettingsRowLayout>
						<SettingsRowLayout label="auto-retry">
							<input
								type="checkbox"
								aria-label="auto-retry"
								checked={state.autoRetryEnabled}
								onChange={(e) =>
									void call("setAutoRetry", [e.currentTarget.checked]).catch((err) =>
										setState("error", String(err)),
									)
								}
							/>
						</SettingsRowLayout>
						<SettingsRowLayout label="Login providers…">
							<button
								type="button"
								class="settings-control-btn"
								onClick={() => setState("modal", "login")}
							>
								manage
							</button>
						</SettingsRowLayout>
					</Show>
				</div>
			</Show>
			<Show when={authSnapshot().status === "signedIn"}>
				<div class="settings-group">
					<h3 class="settings-group-title">Session</h3>
					<SettingsRowLayout label="sign out">
						<button
							type="button"
							class="settings-control-btn"
							onClick={() => {
								void signOut().catch(() => undefined);
							}}
						>
							sign out
						</button>
					</SettingsRowLayout>
				</div>
			</Show>
			<Show
				when={
					(props.visibleGroup === null || props.visibleGroup === "Images") &&
					appearanceWebImages(props.model).length > 0
				}
			>
				<div class="settings-group">
					<h3 class="settings-group-title">Images</h3>
					<For each={appearanceWebImages(props.model)}>{(item) => <SettingsRow item={item} />}</For>
				</div>
			</Show>
		</>
	);
}
