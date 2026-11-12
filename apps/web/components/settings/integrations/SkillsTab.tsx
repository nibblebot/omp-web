import { For, onMount, Show, type Component } from "solid-js";
import {
	extensionBusy,
	extensionsSelected,
	refreshSkills,
	selectedSkill,
	selectExtension,
	setSkillEnabled,
	skills,
	skillsError,
	skillsLoading,
	skillWarnings,
	visibleSkills,
} from "../../../store/integrations";
import { ExtensionRow } from "./ExtensionRow";
import { ExtensionsLayout } from "./ExtensionsLayout";
import { SkillDetailPanel } from "./SkillDetailPanel";

/** The skills the agent can load, searchable, with a switch per row and the selected one's instructions beside the list. */
export const SkillsTab: Component = () => {
	onMount(refreshSkills);
	return (
		<ExtensionsLayout
			search="Search skills"
			list={
				<>
					<Show when={skillsError()}>
						{(msg) => (
							<div class="msg-notice" role="alert">
								{msg()}
							</div>
						)}
					</Show>
					<For each={skillWarnings()}>{(warning) => <div class="msg-notice">{warning}</div>}</For>
					<Show when={skillsLoading() && skills().length === 0}>
						<div class="tool-collapsed-note">Loading skills…</div>
					</Show>
					<Show when={visibleSkills().length > 0}>
						<ul class="extensions-list" aria-label="Skills">
							<For each={visibleSkills()}>
								{(skill) => (
									<ExtensionRow
										name={skill.name}
										source={skill.source}
										badge={skill.hidden ? "hidden" : undefined}
										enabled={skill.enabled}
										selected={
											extensionsSelected()?.kind === "skill" &&
											extensionsSelected()?.name === skill.name
										}
										busy={extensionBusy("skill", skill.name)}
										onSelect={() => selectExtension({ kind: "skill", name: skill.name })}
										onToggle={(enabled) => setSkillEnabled(skill.name, enabled)}
									/>
								)}
							</For>
						</ul>
					</Show>
					<Show when={!skillsLoading() && skills().length === 0}>
						<div class="tool-collapsed-note">
							No skills found in the skill folders the agent scans. Install skills from a terminal
							with <code>omp skill install &lt;spec&gt;</code>.
						</div>
					</Show>
					<Show when={skills().length > 0 && visibleSkills().length === 0}>
						<div class="tool-collapsed-note">Nothing matches the search.</div>
					</Show>
				</>
			}
			detail={
				<Show
					when={selectedSkill()}
					fallback={<div class="tool-collapsed-note">Select a skill to see its details.</div>}
				>
					{(skill) => <SkillDetailPanel skill={skill()} />}
				</Show>
			}
		/>
	);
};
