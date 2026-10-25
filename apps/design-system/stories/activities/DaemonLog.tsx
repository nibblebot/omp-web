import { DaemonLog } from "../../../web/components/activities/DaemonLog";
import { seedDaemons } from "../../fixtures/activities";
import { rosterDaemonInfos } from "../../fixtures/roster";
import { defineStory } from "../../registry";

const daemon = (name: string) => {
	const found = rosterDaemonInfos(Date.now()).find((info) => info.name === name);
	if (found === undefined) throw new Error(`unknown daemon ${name}`);
	return found;
};

const log = (name: string) => (
	<div class="ds-frame">
		<DaemonLog daemon={daemon(name)} id={`daemon-log-${name}`} />
	</div>
);

export default defineStory({
	id: "activities-daemon-log",
	title: "DaemonLog",
	component: { file: "apps/web/components/activities/DaemonLog.tsx", export: "DaemonLog" },
	variants: [
		{
			name: "Log tail",
			description: "Fetched when the body mounts; Refresh asks again and keeps the tail meanwhile.",
			seed: () => seedDaemons(),
			render: () => log("vite-dev"),
		},
		{
			name: "Long log",
			description: "Past the body's height cap the tail scrolls inside it, under a sticky bar.",
			seed: () =>
				seedDaemons({
					"vite-dev": Array.from(
						{ length: 120 },
						(_, i) => `10:${String(i % 60).padStart(2, "0")}:00 [vite] hmr update /file-${i}.tsx`,
					).join("\n"),
				}),
			render: () => log("vite-dev"),
		},
		{
			name: "No output yet",
			description: "An empty tail says so.",
			seed: () => seedDaemons(),
			render: () => log("fleet-edge"),
		},
		{
			name: "Fetch failed",
			description: "The error shows as an alert; Refresh retries.",
			seed: () => seedDaemons({ "vite-dev": new Error("daemon not found on this host") }),
			render: () => log("vite-dev"),
		},
	],
});
