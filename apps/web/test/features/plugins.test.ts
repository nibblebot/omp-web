import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { unwrap } from "solid-js/store";
import { renderToString } from "solid-js/web";
import { McpTab } from "../../components/settings/integrations/McpTab";
import { SkillsTab } from "../../components/settings/integrations/SkillsTab";
import { IntegrationsDialog } from "../../components/settings/integrations/IntegrationsDialog";
import { PluginsTab } from "../../components/settings/integrations/PluginsTab";
import { Modal } from "../../components/ui/Modal";
import { FEATURE_IDS, type FeatureId } from "../../features/manifest";
import { activateFeatures, isFeatureEnabled } from "../../features/registry";
import { openItems } from "../../palette/palette";
import { setState, state } from "../../state";
import type { IntegrationTab } from "../../store/slices/integrations";
import { runPaletteItem } from "../../store/palette";
import { installJsxShim, restoreJsxShim } from "../web.testkit";

/**
 * The Extensions dialog always has Skills and MCP tabs; its Plugins tab appears only
 * while the `plugins` feature is active, with the tab body arriving through the
 * feature's `pluginsTab` slot. Rendered through solid's SSR runtime with the Modal
 * shell and the tab bodies replaced by markers, so only the dialog's own composition
 * is asserted.
 */

const originalActive = new Set<FeatureId>(FEATURE_IDS.filter(isFeatureEnabled));
const originalIntegrations = structuredClone(unwrap(state.integrations));
const originalModal = state.modal;

beforeEach(() => {
	restoreJsxShim();
	installJsxShim({
		onElement(type, props) {
			if (type === Modal) return { value: props.children };
			if (type === SkillsTab) return { value: "<!--skills-tab-->" };
			if (type === McpTab) return { value: "<!--mcp-tab-->" };
			if (type === PluginsTab) return { value: "<!--plugins-tab-->" };
			return undefined;
		},
	});
	setState("modal", originalModal);
});

afterAll(async () => {
	restoreJsxShim();
	await activateFeatures([...originalActive]);
	setState("integrations", originalIntegrations);
	setState("modal", originalModal);
});

/** Render the dialog with exactly `features` active and `tab` stored. */
async function render(features: readonly FeatureId[], tab: IntegrationTab): Promise<string> {
	await activateFeatures(features);
	setState("integrations", "tab", tab);
	return renderToString(() => createComponent(IntegrationsDialog, { onClose: () => {} }));
}

/** Tab ids in the order the tab list shows them. */
const tabOrder = (html: string) =>
	[...html.matchAll(/id="integrations-tab-(\w+)"/g)].map((match) => match[1]);

describe("IntegrationsDialog with the plugins feature on", () => {
	test("lists Skills, Plugins, and MCP, and shows the stored Plugins tab", async () => {
		const html = await render(["plugins"], "plugins");
		expect(tabOrder(html)).toEqual(["skills", "plugins", "mcp"]);
		expect(html).toContain("<!--plugins-tab-->");
		expect(html).not.toContain("<!--skills-tab-->");
		expect(html).not.toContain("<!--mcp-tab-->");
	});

	test("shows the stored Skills or MCP tab's body only", async () => {
		const skills = await render(["plugins"], "skills");
		expect(skills).toContain("<!--skills-tab-->");
		expect(skills).not.toContain("<!--plugins-tab-->");
		expect(skills).not.toContain("<!--mcp-tab-->");
		const mcp = await render(["plugins"], "mcp");
		expect(mcp).toContain("<!--mcp-tab-->");
		expect(mcp).not.toContain("<!--skills-tab-->");
		expect(mcp).not.toContain("<!--plugins-tab-->");
	});
});

describe("IntegrationsDialog with the plugins feature off", () => {
	test("lists Skills and MCP, and shows Skills when Plugins is stored", async () => {
		const html = await render([], "plugins");
		expect(tabOrder(html)).toEqual(["skills", "mcp"]);
		expect(html).toContain('role="tablist"');
		expect(html).toContain("<!--skills-tab-->");
		expect(html).not.toContain("<!--plugins-tab-->");
	});
});

describe("the palette's Extensions entries", () => {
	test("Skills and MCP servers open the dialog on their tab with no feature active", () => {
		const items = openItems({
			debugEnabled: false,
			pluginsEnabled: false,
			providerLoginEnabled: false,
			projects: [],
		});
		setState("modal", null);
		runPaletteItem(items.find((item) => item.label === "MCP servers")!);
		expect(state.modal).toBe("integrations");
		expect(state.integrations.tab).toBe("mcp");
		runPaletteItem(items.find((item) => item.label === "Skills")!);
		expect(state.integrations.tab).toBe("skills");
	});

	test("Plugins opens the dialog on the Plugins tab", () => {
		const items = openItems({
			debugEnabled: false,
			pluginsEnabled: true,
			providerLoginEnabled: false,
			projects: [],
		});
		setState("integrations", "tab", "skills");
		runPaletteItem(items.find((item) => item.label === "Plugins")!);
		expect(state.modal).toBe("integrations");
		expect(state.integrations.tab).toBe("plugins");
	});
});
