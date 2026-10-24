import { JobsBar } from "../components/jobs/JobsBar";
import { JobsButton } from "../components/jobs/JobsButton";
import { JobsSheet } from "../components/jobs/JobsSheet";
import "./jobs.css";
import type { FeatureModule } from "./registry";

export default {
	id: "jobs",
	modals: {
		jobs: (props) => <JobsSheet onClose={props.onClose} />,
	},
	composerBars: [JobsBar],
	settingsAction: JobsButton,
} satisfies FeatureModule;
