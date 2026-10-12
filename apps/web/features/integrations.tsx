import { McpServersDialog } from "../components/settings/integrations/McpServersDialog";
import { SkillsDialog } from "../components/settings/integrations/SkillsDialog";
import { openOrForward } from "../prompt/commands";
import type { FeatureModule } from "./registry";

export default {
	id: "integrations",
	modals: {
		mcp: (props) => <McpServersDialog onClose={props.onClose} />,
		skills: (props) => <SkillsDialog onClose={props.onClose} />,
	},
	commands: {
		mcp: {
			detail: "MCP servers (/mcp [add|list|remove|test])",
			run: openOrForward("mcp", "mcp"),
		},
		skills: {
			detail: "Skills (/skills [subcommand])",
			run: openOrForward("skills", "skills"),
		},
	},
} satisfies FeatureModule;
