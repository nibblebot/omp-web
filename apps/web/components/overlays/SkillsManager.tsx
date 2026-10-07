import { createSignal, For, onMount, Show, type Component } from "solid-js";
import { Modal } from "../shared/Modal";
import {
	installSkill,
	managePlugin,
	plugins,
	refreshSkills,
	reloadIntegrations,
	reloadStatus,
	searchSkills,
	skillResults,
	skillSearching,
	skills,
	skillsError,
	skillsLoading,
	skillsUnavailable,
	smitheryAvailable,
	uninstallSkill,
	updateSkill,
} from "../../store/integrations";

export const SkillsManager: Component<{ onClose: () => void }> = (props) => {
	const [filter, setFilter] = createSignal("");
	const [query, setQuery] = createSignal("");
	const [scope, setScope] = createSignal<"project" | "profile">("profile");
	const [pluginSource, setPluginSource] = createSignal("");

	onMount(() => {
		refreshSkills();
	});

	const visibleSkills = () => {
		const q = filter().toLowerCase();
		const list = skills();
		return q
			? list.filter(
					(s) =>
						s.id.toLowerCase().includes(q) ||
						(s.source ?? "").toLowerCase().includes(q) ||
						(s.description ?? "").toLowerCase().includes(q),
				)
			: list;
	};

	const visiblePlugins = () => {
		const q = filter().toLowerCase();
		const list = plugins();
		return q
			? list.filter(
					(p) =>
						p.id.toLowerCase().includes(q) ||
						(p.source ?? "").toLowerCase().includes(q) ||
						(p.description ?? "").toLowerCase().includes(q),
				)
			: list;
	};

	return (
		<Modal title="Skills & plugins" onClose={props.onClose}>
			<input
				class="picker-filter"
				aria-label="Filter installed skills and plugins"
				placeholder="Filter installed…"
				value={filter()}
				onInput={(e) => setFilter(e.currentTarget.value)}
			/>
			<Show when={skillsUnavailable()}>{(msg) => <div class="msg-notice">{msg()}</div>}</Show>
			<Show when={skillsError()}>{(err) => <div class="msg-notice">{err()}</div>}</Show>
			<Show when={reloadStatus()}>
				{(message) => (
					<div role="status" class="msg-notice">
						{message()}
					</div>
				)}
			</Show>
			<Show when={skillsLoading()}>
				<div class="tool-collapsed-note">Loading skills and plugins…</div>
			</Show>
			<div class="picker-group-name">Installed skills</div>
			<Show
				when={visibleSkills().length > 0}
				fallback={
					<Show when={!skillsLoading() && !skillsUnavailable()}>
						<div class="tool-collapsed-note">No skills installed.</div>
					</Show>
				}
			>
				<div class="picker-list">
					<For each={visibleSkills()}>
						{(s) => (
							<div class="settings-row">
								<span class="picker-label">
									{s.id}
									<Show when={s.version}>
										<span class="tool-collapsed-note"> · {s.version}</span>
									</Show>
									<Show when={s.source}>
										<span class="tool-collapsed-note"> · {s.source}</span>
									</Show>
									<Show when={s.enabled === false}>
										<span class="tool-collapsed-note"> · disabled</span>
									</Show>
								</span>
								<div>
									<button
										type="button"
										class="settings-control-btn"
										onClick={() => updateSkill(s.id, scope())}
									>
										update
									</button>
									<button
										type="button"
										class="settings-control-btn"
										onClick={() => uninstallSkill(s.id)}
									>
										uninstall
									</button>
								</div>
							</div>
						)}
					</For>
				</div>
			</Show>
			<div class="picker-group-name">Installed plugins</div>
			<Show
				when={visiblePlugins().length > 0}
				fallback={
					<Show when={!skillsLoading() && !skillsUnavailable()}>
						<div class="tool-collapsed-note">No plugins installed.</div>
					</Show>
				}
			>
				<div class="picker-list">
					<For each={visiblePlugins()}>
						{(p) => (
							<div class="settings-row">
								<span class="picker-label">
									{p.id}
									<Show when={p.version}>
										<span class="tool-collapsed-note"> · {p.version}</span>
									</Show>
									<Show when={p.source}>
										<span class="tool-collapsed-note"> · {p.source}</span>
									</Show>
									<Show when={p.enabled === false}>
										<span class="tool-collapsed-note"> · disabled</span>
									</Show>
								</span>
								<div>
									<Show
										when={p.enabled === false}
										fallback={
											<button
												type="button"
												class="settings-control-btn"
												onClick={() => managePlugin("disable", p.id)}
											>
												disable
											</button>
										}
									>
										<button
											type="button"
											class="settings-control-btn"
											onClick={() => managePlugin("enable", p.id)}
										>
											enable
										</button>
									</Show>
									<button
										type="button"
										class="settings-control-btn"
										onClick={() => managePlugin("update", p.id, scope())}
									>
										update
									</button>
									<button
										type="button"
										class="settings-control-btn"
										onClick={() => managePlugin("uninstall", p.id)}
									>
										uninstall
									</button>
								</div>
							</div>
						)}
					</For>
				</div>
			</Show>
			<div class="picker-group-name">Find and install</div>
			<div class="msg-notice">
				Skills and plugins ship executable code that runs with your permissions. Installing asks for
				confirmation first — only install what you trust.
			</div>
			<Show when={!smitheryAvailable()}>
				<div class="msg-notice">
					Smithery MCP registry access is unavailable. Skill search uses the configured skill
					registry; installed skills and plugins remain visible.
				</div>
			</Show>
			<select
				aria-label="Installation scope"
				value={scope()}
				onChange={(e) => setScope(e.currentTarget.value === "project" ? "project" : "profile")}
			>
				<option value="profile">Profile</option>
				<option value="project">Project</option>
			</select>
			<div class="settings-row">
				<input
					class="picker-filter"
					aria-label="Plugin package or source"
					placeholder="Plugin package/source"
					value={pluginSource()}
					onInput={(e) => setPluginSource(e.currentTarget.value)}
				/>
				<button
					type="button"
					class="settings-control-btn"
					disabled={!pluginSource().trim()}
					onClick={() => managePlugin("install", pluginSource().trim(), scope())}
				>
					install plugin
				</button>
			</div>
			<div class="settings-row">
				<input
					class="picker-filter"
					aria-label="Search the skill registry"
					placeholder="Search registry…"
					value={query()}
					onInput={(e) => setQuery(e.currentTarget.value)}
				/>
				<button
					type="button"
					class="settings-control-btn"
					disabled={skillSearching()}
					onClick={() => searchSkills(query().trim())}
				>
					search
				</button>
			</div>
			<Show when={skillSearching()}>
				<div class="tool-collapsed-note">Searching…</div>
			</Show>
			<Show when={skillResults().length > 0}>
				<div class="picker-list">
					<For each={skillResults()}>
						{(r) => (
							<div class="settings-row">
								<span class="picker-label">
									{r.id}
									<Show when={r.description}>
										<span class="tool-collapsed-note"> · {r.description}</span>
									</Show>
								</span>
								<button
									type="button"
									class="settings-control-btn"
									onClick={() => installSkill(r.id, scope())}
								>
									install
								</button>
							</div>
						)}
					</For>
				</div>
			</Show>
			<div class="picker-group-name">Reload</div>
			<div class="settings-row">
				<span class="picker-label">
					Reload runtime tools, instructions, skills, and extensions with explicit disruption
					consent.
				</span>
				<button type="button" class="settings-control-btn" onClick={reloadIntegrations}>
					reload integrations
				</button>
			</div>
		</Modal>
	);
};
