import { createEffect, For, on, Show, type Component } from "solid-js";
import type { SkillSummary } from "#lib/wire/protocol";
import {
	extensionBusy,
	loadSkillDetail,
	setSkillEnabled,
	skillDetail,
	skillsRevision,
} from "../../../store/integrations";
import { Markdown } from "../../ui/Markdown";
import { SettingToggle } from "../controls/SettingToggle";

/** A skill's full detail: state, origin, how it applies, and its SKILL.md body. */
export const SkillDetailPanel: Component<{ skill: SkillSummary }> = (props) => {
	const s = () => props.skill;
	// `skills_changed` (or any applied inventory) bumps the revision: re-read what is shown.
	createEffect(on(skillsRevision, () => loadSkillDetail(s().name), { defer: true }));
	const loaded = () => {
		const current = skillDetail();
		return current?.name === s().name ? current : null;
	};

	return (
		<article class="extension-detail" aria-label={`${s().name} skill`}>
			<header class="extension-detail-head">
				<h3 class="extension-detail-title">{s().name}</h3>
				<SettingToggle
					label={s().name}
					checked={s().enabled}
					disabled={extensionBusy("skill", s().name)}
					onChange={(enabled) => setSkillEnabled(s().name, enabled)}
				/>
			</header>
			<p class="integrations-hint">
				{s().enabled
					? "On: the agent can use this skill."
					: "Off: the agent does not see this skill."}
			</p>
			<p class="extension-detail-text">{s().description || "No description."}</p>
			<dl class="extension-facts">
				<dt>Origin</dt>
				<dd>
					{s().source}
					<code class="integrations-target">{s().path}</code>
				</dd>
				<Show when={s().hidden}>
					<dt>Listing</dt>
					<dd>Hidden from the skill listing the agent receives.</dd>
				</Show>
				<Show when={loaded()?.detail}>
					{(detail) => (
						<>
							<dt>Always apply</dt>
							<dd>{detail().alwaysApply ? "Yes: applied to every prompt." : "No"}</dd>
							<Show when={detail().globs.length > 0}>
								<dt>Globs</dt>
								<dd>
									<ul class="integrations-chips" aria-label="Globs">
										<For each={detail().globs}>{(glob) => <li>{glob}</li>}</For>
									</ul>
								</dd>
							</Show>
						</>
					)}
				</Show>
			</dl>
			<Show when={loaded()?.error}>
				{(message) => (
					<div class="msg-notice" role="alert">
						{message()}
					</div>
				)}
			</Show>
			<Show when={loaded()?.loading && !loaded()?.detail}>
				<div class="tool-collapsed-note">Loading skill…</div>
			</Show>
			<Show when={loaded()?.detail}>
				{(detail) => (
					<section class="extension-body" aria-label="SKILL.md">
						<Show
							when={detail().body.trim() !== ""}
							fallback={<div class="tool-collapsed-note">This skill has no instructions body.</div>}
						>
							<Markdown src={detail().body} />
						</Show>
					</section>
				)}
			</Show>
		</article>
	);
};
