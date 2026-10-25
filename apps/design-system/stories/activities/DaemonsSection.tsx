import { daemonsKey } from "#lib/wire/protocol";
import { DaemonsSection } from "../../../web/components/activities/DaemonsSection";
import { setActivitiesMode, toggleItemExpanded } from "../../../web/store/activities";
import { seedDaemons } from "../../fixtures/activities";
import { rosterDaemonInfos } from "../../fixtures/roster";
import { DockFrame } from "../../fixtures/subagents";
import { defineStory } from "../../registry";

const section = (width = 520) => (
	<DockFrame title="Activities" width={width} flush>
		<div class="activities-panel">
			<div class="activities-list">
				<DaemonsSection />
			</div>
		</div>
	</DockFrame>
);

const expand = (name: string) => {
	const info = rosterDaemonInfos(0).find((daemon) => daemon.name === name);
	if (info === undefined) throw new Error(`unknown daemon ${name}`);
	toggleItemExpanded({ section: "daemons", id: daemonsKey(info) });
};

export default defineStory({
	id: "activities-daemons-section",
	title: "DaemonsSection",
	component: {
		file: "apps/web/components/activities/DaemonsSection.tsx",
		export: "DaemonsSection",
	},
	variants: [
		{
			name: "Workspace daemons",
			description:
				"The selected workspace's live supervised processes under the Daemons header with the active count. bench-runner (another workspace) and docs-watch (exited) are not listed. Restart and kill act in place.",
			seed: () => seedDaemons(),
			render: () => section(),
		},
		{
			name: "Log expanded",
			description:
				"A row expanded to the tail of its log, under the row inside the same item; Refresh fetches it again.",
			seed: () => {
				seedDaemons();
				expand("vite-dev");
			},
			render: () => section(),
		},
		{
			name: "Detail mode",
			description:
				"Daemons have no detail view: rows expand inline in detail mode too, with the same log body.",
			seed: () => {
				seedDaemons();
				setActivitiesMode("detail");
				expand("design-server");
			},
			render: () => section(),
		},
		{
			name: "Several expanded",
			description: "Two logs open at once; an empty log says so.",
			seed: () => {
				seedDaemons();
				expand("vite-dev");
				expand("fleet-edge");
			},
			render: () => section(),
		},
		{
			name: "Log fetch fails",
			description: "The broker refused the log: the error shows in the body and Refresh retries.",
			seed: () => {
				seedDaemons({ "vite-dev": new Error("daemon not found on this host") });
				expand("vite-dev");
			},
			render: () => section(),
		},
		{
			name: "Narrow dock, 420px",
			description:
				"The endpoint and uptime give way first; name, state and both actions stay readable without horizontal overflow.",
			seed: () => {
				seedDaemons();
				expand("design-server");
			},
			render: () => section(420),
		},
	],
});
