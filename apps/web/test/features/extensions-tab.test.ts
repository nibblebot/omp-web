import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { McpServerSummary, SkillSummary } from "#lib/wire/protocol";
import { ExtensionsTab } from "../../components/settings/integrations/ExtensionsTab";
import { FEATURE_IDS, type FeatureId } from "../../features/manifest";
import { activateFeatures, isFeatureEnabled } from "../../features/registry";
import { setState } from "../../state";
import { createIntegrationState } from "../../store/slices/integrations";
import { installJsxShim, restoreJsxShim } from "../web.testkit";

/**
 * The Extensions tab is core: it lists skills and MCP servers whichever optional
 * features are active. Rendered through solid's SSR runtime with both lists loaded.
 */

const originalActive = new Set<FeatureId>(FEATURE_IDS.filter(isFeatureEnabled));

const skill: SkillSummary = {
	name: "pdf-skill",
	description: "Read PDFs",
	source: "OMP (project)",
	path: "/repo/.omp/skills/pdf-skill/SKILL.md",
	enabled: true,
	hidden: false,
};

const server: McpServerSummary = {
	name: "filesystem-server",
	transport: "stdio",
	status: "connected",
	enabled: true,
	scope: "project",
	writable: true,
	command: "npx",
	auth: "none",
};

beforeEach(() => {
	restoreJsxShim();
	installJsxShim();
	setState("integrations", createIntegrationState());
	setState("integrations", { skills: [skill], mcpServers: [server] });
});

afterAll(async () => {
	restoreJsxShim();
	await activateFeatures([...originalActive]);
	setState("integrations", createIntegrationState());
});

describe("ExtensionsTab", () => {
	test("lists skills and MCP servers with no optional feature active", async () => {
		await activateFeatures([]);
		const html = renderToString(() => createComponent(ExtensionsTab, {}));
		expect(html).toContain("pdf-skill");
		expect(html).toContain("filesystem-server");
		expect(html).toContain("Add server");
	});
});
