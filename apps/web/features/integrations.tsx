import { IntegrationsSheet } from "../components/settings/integrations/IntegrationsSheet";
import { openOrForward } from "../prompt/commands";
import { pushNotice } from "../store/chat";
import { openIntegrations } from "../store/integrations";
import type { FeatureModule } from "./registry";

const forwardMcp = openOrForward("integrations", "mcp");

export default {
	id: "integrations",
	modals: {
		integrations: (props) => <IntegrationsSheet onClose={props.onClose} />,
	},
	commands: {
		mcp: {
			detail: "MCP servers (/mcp [add|list|remove|test])",
			// Bare opens the sheet on MCP servers; arguments follow the SDK's /mcp grammar and go to the agent.
			run: (args) => (args.trim() ? forwardMcp(args) : openIntegrations("mcp")),
		},
		skills: {
			detail: "Skills (/skills [installed])",
			// Skill install, update, and search are terminal commands (`omp skill ...`); the sheet covers listing and toggling.
			run: (args) => {
				const sub = args.trim();
				if (sub === "" || sub === "installed") openIntegrations("skills");
				else
					pushNotice(
						"error",
						`/skills ${sub} is terminal-only. Install or update skills with "omp skill ${sub}" in a terminal; turn skills on or off in the Integrations sheet.`,
					);
			},
		},
	},
} satisfies FeatureModule;
