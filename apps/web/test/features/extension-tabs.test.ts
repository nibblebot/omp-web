import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { McpServerSummary, SkillSummary } from "#lib/wire/protocol";
import { McpTab } from "../../components/settings/integrations/McpTab";
import { SkillsTab } from "../../components/settings/integrations/SkillsTab";
import { FEATURE_IDS, type FeatureId } from "../../features/manifest";
import { activateFeatures, isFeatureEnabled } from "../../features/registry";
import { setState } from "../../state";
import { createIntegrationState } from "../../store/slices/integrations";
import { installJsxShim, restoreJsxShim } from "../web.testkit";

/**
 * The Skills and MCP tabs are core: each lists its own inventory whichever optional
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

beforeEach(async () => {
	restoreJsxShim();
	installJsxShim();
	await activateFeatures([]);
	setState("integrations", createIntegrationState());
	setState("integrations", { skills: [skill], mcpServers: [server] });
});

afterAll(async () => {
	restoreJsxShim();
	await activateFeatures([...originalActive]);
	setState("integrations", createIntegrationState());
});

describe("SkillsTab", () => {
	test("lists skills only, with no optional feature active", () => {
		const html = renderToString(() => createComponent(SkillsTab, {}));
		expect(html).toContain("pdf-skill");
		expect(html).not.toContain("filesystem-server");
	});
});

describe("McpTab", () => {
	test("lists MCP servers only, with Add server, with no optional feature active", () => {
		const html = renderToString(() => createComponent(McpTab, {}));
		expect(html).toContain("filesystem-server");
		expect(html).not.toContain("pdf-skill");
		expect(html).toContain("Add server");
	});

	test("a selected skill shows no detail on the MCP tab", () => {
		setState("integrations", "extensionsSelected", { kind: "skill", name: "pdf-skill" });
		const html = renderToString(() => createComponent(McpTab, {}));
		expect(html).not.toContain('aria-label="pdf-skill skill"');
	});
});
