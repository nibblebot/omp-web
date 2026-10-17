import { createSignal, For, onMount, Show, type Component } from "solid-js";
import type { SkillSummary } from "#lib/wire/protocol";
import {
	refreshSkills,
	setSkillEnabled,
	skills,
	skillsError,
	skillsLoading,
	skillWarnings,
} from "../../../store/integrations";

const SkillRow: Component<{ skill: SkillSummary }> = (props) => {
	const s = () => props.skill;
	return (
		<li class="integrations-row" data-enabled={s().enabled ? "true" : "false"}>
			<div class="integrations-row-main">
				<details>
					<summary class="integrations-row-head">
						<strong class="integrations-row-name">{s().name}</strong>
						<span class="integrations-badge">{s().source}</span>
						<span class="integrations-badge">{s().enabled ? "on" : "off"}</span>
						<Show when={s().hidden}>
							<span class="integrations-badge">hidden from listing</span>
						</Show>
					</summary>
					<div class="integrations-row-detail">
						<p>{s().description || "No description."}</p>
						<p>
							<code class="integrations-target">{s().path}</code>
						</p>
						<p class="integrations-hint">
							Invoke with <code>/skill:{s().name}</code> in the composer.
						</p>
					</div>
				</details>
			</div>
			<div class="integrations-row-actions">
				<button
					type="button"
					class="settings-control-btn"
					onClick={() => setSkillEnabled(s().name, !s().enabled)}
				>
					{s().enabled ? "Disable" : "Enable"}
				</button>
			</div>
		</li>
	);
};

export const SkillsTab: Component = () => {
	const [filter, setFilter] = createSignal("");

	onMount(() => refreshSkills());

	const visible = () => {
		const query = filter().trim().toLowerCase();
		if (query === "") return skills();
		return skills().filter((skill) =>
			`${skill.name} ${skill.description} ${skill.source}`.toLowerCase().includes(query),
		);
	};

	return (
		<div class="integrations-tab integrations-skills">
			<div class="integrations-toolbar">
				<input
					class="picker-filter"
					type="search"
					aria-label="Filter skills"
					placeholder="Filter by name, description, or source"
					value={filter()}
					onInput={(e) => setFilter(e.currentTarget.value)}
				/>
			</div>
			<p class="integrations-hint">
				Install or update skills from a terminal with <code>omp skill install &lt;spec&gt;</code>.
				Turn them on or off here.
			</p>
			<Show when={skillsError()}>
				{(msg) => (
					<div class="msg-notice" role="alert">
						{msg()}
					</div>
				)}
			</Show>
			<For each={skillWarnings()}>{(warning) => <div class="msg-notice">{warning}</div>}</For>
			<Show when={skillsLoading()}>
				<div class="tool-collapsed-note">Loading skills…</div>
			</Show>
			<Show when={visible().length > 0}>
				<ul class="integrations-list" aria-label="Skills">
					<For each={visible()}>{(skill) => <SkillRow skill={skill} />}</For>
				</ul>
			</Show>
			<Show when={!skillsLoading() && visible().length === 0}>
				<div class="tool-collapsed-note">
					{skills().length === 0
						? "No skills found in the skill folders the agent scans."
						: "No skills match the filter."}
				</div>
			</Show>
		</div>
	);
};
