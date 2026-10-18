import { createSignal, onMount, Show } from "solid-js";
import { NewWorkspacePopover } from "../../../../web/components/fleet/sidebar/NewWorkspacePopover";
import { rememberWorkspaceCreationPrefs } from "../../../../web/prefs/workspace-creation";
import { answerNewWorkspaceCommands } from "../../../fixtures/new-workspace";
import { rosterProjects } from "../../../fixtures/roster";
import { seedRosterFleet } from "../../../fixtures/roster-seed";
import { defineStory } from "../../../registry";

const PROJECT_ID = "proj_omp_web";

/** A "+" trigger that owns the popover, as the project group header does. `typed` and
 *  `submit` drive the search field the way a user would, after the popover mounts. */
function Anchored(props: { typed?: string; submit?: boolean }) {
	const [anchor, setAnchor] = createSignal<HTMLElement>();
	const [open, setOpen] = createSignal(true);
	onMount(() => {
		if (props.typed === undefined) return;
		setTimeout(() => {
			const input = document.querySelector<HTMLInputElement>(".new-workspace-search");
			if (input === null) return;
			input.value = props.typed ?? "";
			input.dispatchEvent(new Event("input", { bubbles: true }));
			if (props.submit === true) {
				input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
			}
		}, 0);
	});
	return (
		<div class="sidebar-list">
			<button
				type="button"
				class="sidebar-icon-btn"
				ref={setAnchor}
				aria-label="New workspace"
				aria-expanded={open()}
				onClick={() => setOpen(!open())}
			>
				+
			</button>
			<Show when={open() ? anchor() : undefined}>
				{(el) => (
					<NewWorkspacePopover
						projectId={PROJECT_ID}
						anchor={el()}
						onClose={() => setOpen(false)}
					/>
				)}
			</Show>
		</div>
	);
}

export default defineStory({
	id: "fleet-sidebar-new-workspace-popover",
	title: "NewWorkspacePopover",
	component: {
		file: "apps/web/components/fleet/sidebar/NewWorkspacePopover.tsx",
		export: "NewWorkspacePopover",
	},
	seed: () => seedRosterFleet(),
	tabs: true,
	variants: [
		{
			name: "This machine: local branches",
			seed: () => answerNewWorkspaceCommands(),
			render: () => <Anchored />,
		},
		{
			name: "Typed name: create branch row",
			seed: () => answerNewWorkspaceCommands(),
			render: () => <Anchored typed="feat/new-panel" />,
		},
		{
			name: "Provider clone from origin",
			seed: () => {
				answerNewWorkspaceCommands();
				rememberWorkspaceCreationPrefs(PROJECT_ID, {
					kind: "clone",
					profileId: "k8s-bench",
					source: "remote",
					remote: "origin",
				});
			},
			render: () => <Anchored />,
		},
		{
			name: "Creating: progress until ready",
			seed: () => answerNewWorkspaceCommands({ create: "hang" }),
			render: () => <Anchored typed="feat/new-panel" submit />,
		},
		{
			name: "Refused: error inline, input kept",
			seed: () => answerNewWorkspaceCommands({ create: "refuse" }),
			render: () => <Anchored typed="feat/refused" submit />,
		},
		{
			name: "Project missing on disk",
			seed: () =>
				seedRosterFleet({
					registeredProjects: rosterProjects.map((project) =>
						project.projectId === PROJECT_ID ? { ...project, missing: true } : project,
					),
				}),
			render: () => <Anchored />,
		},
	],
});
