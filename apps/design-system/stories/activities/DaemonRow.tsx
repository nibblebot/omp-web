import { DaemonRow } from "../../../web/components/activities/DaemonRow";
import { seedDaemons } from "../../fixtures/activities";
import { rosterDaemonInfos } from "../../fixtures/roster";
import { defineStory } from "../../registry";

const daemon = (name: string) => {
	const found = rosterDaemonInfos(Date.now()).find((info) => info.name === name);
	if (found === undefined) throw new Error(`unknown daemon ${name}`);
	return found;
};

export default defineStory({
	id: "activities-daemon-row",
	title: "DaemonRow",
	component: { file: "apps/web/components/activities/DaemonRow.tsx", export: "DaemonRow" },
	variants: [
		{
			name: "Ready endpoint",
			description:
				"State glyph, name, state, host:port, ticking uptime and restart / kill. The summary is a toggle (aria-expanded false).",
			seed: () => seedDaemons(),
			render: () => (
				<div class="ds-frame">
					<DaemonRow daemon={daemon("vite-dev")} expanded={false} onToggle={() => undefined} />
				</div>
			),
		},
		{
			name: "Expanded",
			description: "The toggle reports aria-expanded true and points at the log region.",
			seed: () => seedDaemons(),
			render: () => (
				<div class="ds-frame">
					<DaemonRow
						daemon={daemon("design-server")}
						expanded
						bodyId="daemon-log-demo"
						onToggle={() => undefined}
					/>
				</div>
			),
		},
		{
			name: "Starting, no endpoint",
			description: "A process that declared no port shows none.",
			seed: () => seedDaemons(),
			render: () => (
				<div class="ds-frame">
					<DaemonRow daemon={daemon("fleet-edge")} expanded={false} onToggle={() => undefined} />
				</div>
			),
		},
		{
			name: "Failed",
			description: "The exited process's glyph reads as an error.",
			seed: () => seedDaemons(),
			render: () => (
				<div class="ds-frame">
					<DaemonRow
						daemon={{ ...daemon("docs-watch"), state: "failed" }}
						expanded={false}
						onToggle={() => undefined}
					/>
				</div>
			),
		},
		{
			name: "Compact",
			description: "The activity bar popover's row: no toggle and no uptime, same actions.",
			seed: () => seedDaemons(),
			render: () => (
				<div class="ds-frame">
					<DaemonRow daemon={daemon("vite-dev")} compact />
				</div>
			),
		},
	],
});
