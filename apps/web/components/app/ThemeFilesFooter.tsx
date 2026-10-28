import { For, Show, type Component } from "solid-js";
import { reloadThemes, state } from "../../state";

/**
 * Footer of the theme controls: the folder custom theme files are read from, the
 * Reload themes button (the fleet reads the folder on every request, so a new file shows
 * after a reload), its pending and error state, and an expandable list of the files that
 * failed to load with every reason.
 */
export const ThemeFilesFooter: Component = () => {
	const failures = () => state.themes?.failures ?? [];
	return (
		<div class="theme-files">
			<Show when={state.themes}>
				{(payload) => (
					<p class="theme-files-dir">
						Custom themes load from <code>{payload().dir}</code>
					</p>
				)}
			</Show>
			<div class="theme-files-actions">
				<button
					type="button"
					class="settings-control-btn"
					disabled={state.themesLoading}
					onClick={() => void reloadThemes()}
				>
					Reload themes
				</button>
				<span class="theme-files-status" role="status">
					{state.themesLoading ? "Reloading…" : ""}
				</span>
			</div>
			<Show when={state.themesError}>
				{(message) => (
					<p class="theme-files-error" role="alert">
						Could not load themes: {message()}
					</p>
				)}
			</Show>
			<Show when={failures().length > 0}>
				<details class="theme-files-failures">
					<summary>
						{failures().length} theme {failures().length === 1 ? "file" : "files"} failed to load
					</summary>
					<ul class="theme-files-failure-list">
						<For each={failures()}>
							{(failure) => (
								<li>
									<code>{failure.file}</code>
									<ul>
										<For each={failure.errors}>{(error) => <li>{error}</li>}</For>
									</ul>
								</li>
							)}
						</For>
					</ul>
				</details>
			</Show>
		</div>
	);
};
