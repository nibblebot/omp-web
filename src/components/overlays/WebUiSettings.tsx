import { createSignal, For, Show } from "solid-js";
import { appearanceWebImages } from "../../settings";
import { call, fleetSettingsActive, setNotifyEnabled, setState, state } from "../../state";
import { MinusIcon, PlusIcon } from "../shared/icons";
import {
	currentFontSize,
	currentThemePreference,
	setTheme,
	stepFontSize,
	THEME_OPTIONS,
	type ThemePreference,
} from "../../theme";
import type { SettingsModel } from "../../../shared/protocol";
import { Row, SettingsRow } from "./SettingsRow";

/**
 * "Web UI" section body. Three state sources with intentionally separate
 * update paths (never merged):
 * - client-local (localStorage-backed): theme preference + font size, via
 *   theme.ts; the local signals are seeded from the persisted values;
 * - server model (refreshSettings/updateSetting): the Images group's
 *   images.* items, rendered through SettingsRow;
 * - session-scoped: the reveal/soften store toggles and the fast-mode /
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
					<Row label="theme preference">
						<select
							aria-label="theme preference"
							value={theme()}
							onChange={(e) => setThemeSignal(setTheme(e.currentTarget.value as ThemePreference))}
						>
							<For each={THEME_OPTIONS}>{(o) => <option value={o.id}>{o.label}</option>}</For>
						</select>
					</Row>
					<Row label="font size">
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
					</Row>
					{/* Client-local store toggles (setNotifyEnabled persists to
					    localStorage as well; reveal/soften are UI prefs). */}
					<Row label="desktop notifications">
						<input
							type="checkbox"
							aria-label="desktop notifications"
							checked={state.notifyEnabled}
							onChange={(e) => setNotifyEnabled(e.currentTarget.checked)}
						/>
					</Row>
					<Row label="reveal queue">
						<input
							type="checkbox"
							aria-label="reveal queue"
							checked={state.reveal}
							onChange={(e) => setState("reveal", e.currentTarget.checked)}
						/>
					</Row>
					<Row label="soft fade">
						<input
							type="checkbox"
							aria-label="soft fade"
							checked={state.soften}
							onChange={(e) => setState("soften", e.currentTarget.checked)}
						/>
					</Row>
					{/* Session-RPC rows: no live session under the fleet fallback, so they
					    would only error — hidden, mirroring their main-UI session scope. */}
					<Show when={!fleetSettingsActive()}>
						<Row label="fast mode">
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
						</Row>
						<Row label="auto-retry">
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
						</Row>
						<Row label="Login providers…">
							<button
								type="button"
								class="settings-control-btn"
								onClick={() => setState("modal", "login")}
							>
								manage
							</button>
						</Row>
					</Show>
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
