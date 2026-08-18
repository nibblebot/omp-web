import { createSignal, For, onCleanup, onMount, Show, type Component } from "solid-js";
import { createDirPicker, type DirPicker as DirPickerStore } from "../../fleet-ui/dir-picker";
import { PickerRow } from "../shared/PickerRow";

/**
 * Directory browser for the onboarding modals (Phase 6): breadcrumb of the
 * current path (clickable segments), a manual path input (accepts "~"/"~/…",
 * expanded edge-side), the scrollable subdirectory listing (git badge when
 * the edge reports a .git dir), and a footer button selecting the CURRENT
 * directory. Presentational only — every fetch goes through the dir-picker
 * module (createDirPicker), which the parent may pass in (`picker` prop) to
 * read browse state itself (AddProjectModal's hasGit submit gate).
 */
export const DirPicker: Component<{
	onSelect: (path: string) => void;
	initialPath?: string;
	picker?: DirPickerStore;
}> = (props) => {
	const picker = props.picker ?? createDirPicker();
	const [snap, setSnap] = createSignal(picker.state());
	const [manual, setManual] = createSignal("");

	const unsub = picker.subscribe(() => setSnap({ ...picker.state() }));
	onCleanup(unsub);
	onMount(() => {
		void picker.navigate(props.initialPath);
	});

	/** Path segments as breadcrumb crumbs: root first, then one per part. */
	const crumbs = () => {
		const parts = snap()
			.currentPath.split("/")
			.filter((s) => s !== "");
		const out: Array<{ label: string; path: string }> = [{ label: "/", path: "/" }];
		let acc = "";
		for (const part of parts) {
			acc += `/${part}`;
			out.push({ label: part, path: acc });
		}
		return out;
	};

	/** Display name of the current directory for the footer select button. */
	const basename = () => {
		const p = snap().currentPath;
		if (p === "") return "…";
		if (p === "/") return "/";
		return p.split("/").pop() ?? p;
	};

	const submitManual = (e: SubmitEvent) => {
		e.preventDefault();
		const v = manual().trim();
		if (v !== "") void picker.navigate(v);
	};

	return (
		<div class="dirpick">
			<div class="dirpick-crumbs">
				<For each={crumbs()}>
					{(c, i) => (
						<>
							<Show when={i() > 0}>
								<span class="dirpick-sep">/</span>
							</Show>
							<button
								type="button"
								class="dirpick-crumb"
								classList={{ current: i() === crumbs().length - 1 }}
								disabled={i() === crumbs().length - 1}
								onClick={() => void picker.navigate(c.path)}
							>
								{c.label}
							</button>
						</>
					)}
				</For>
				<button
					type="button"
					class="daemon-row-btn dirpick-refresh"
					title="Reload this listing"
					onClick={() => void picker.refresh()}
				>
					refresh
				</button>
			</div>
			<form class="dirpick-manual" onSubmit={submitManual}>
				<input
					class="picker-filter dirpick-manual-input"
					placeholder="type a path… (~/ ok)"
					value={manual()}
					onInput={(e) => setManual(e.currentTarget.value)}
					spellcheck={false}
				/>
			</form>
			<div class="dirpick-list">
				<Show when={snap().parent}>
					{(p) => (
						<PickerRow class="picker-row dirpick-row" onClick={() => void picker.up()} title={p()}>
							<span class="picker-label dirpick-name">..</span>
						</PickerRow>
					)}
				</Show>
				<For each={snap().dirs}>
					{(d) => (
						<PickerRow
							class="picker-row dirpick-row"
							onClick={() => void picker.navigate(d.path, { hasGit: d.hasGit })}
							title={d.path}
						>
							<span class="picker-label dirpick-name">{d.name}</span>
							<Show when={d.hasGit}>
								<span class="picker-chip dirpick-git">git</span>
							</Show>
						</PickerRow>
					)}
				</For>
				<Show when={snap().loading}>
					<div class="tool-collapsed-note">loading…</div>
				</Show>
				<Show
					when={
						!snap().loading &&
						snap().error === null &&
						snap().currentPath !== "" &&
						snap().dirs.length === 0
					}
				>
					<div class="tool-collapsed-note">no subdirectories</div>
				</Show>
			</div>
			<Show when={snap().error}>
				{(err) => <div class="msg-notice dirpick-error">{err()}</div>}
			</Show>
			<Show when={snap().truncated && !snap().loading}>
				<div class="tool-collapsed-note">listing truncated — showing first 500 entries</div>
			</Show>
			<div class="dirpick-footer">
				<button
					type="button"
					class="dirpick-select"
					disabled={snap().currentPath === "" || snap().loading}
					onClick={() => props.onSelect(snap().currentPath)}
				>
					Select {basename()}
				</button>
			</div>
		</div>
	);
};
