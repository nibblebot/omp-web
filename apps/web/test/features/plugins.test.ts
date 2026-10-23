import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { ExtensionsTab } from "../../components/settings/integrations/ExtensionsTab";
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
 * The Extensions dialog always lists skills and MCP servers; its Plugins tab appears
 * only while the `plugins` feature is active, with the tab body arriving through the
 * feature's `pluginsTab` slot. Rendered through solid's SSR runtime with the Modal
 * shell and both tab bodies replaced by markers, so only the dialog's own composition
 * is asserted.
 */

const originalActive = new Set<FeatureId>(FEATURE_IDS.filter(isFeatureEnabled));
const originalTab = state.integrations.tab;
const originalModal = state.modal;

beforeEach(() => {
	restoreJsxShim();
	installJsxShim({
		onElement(type, props) {
			if (type === Modal) return { value: props.children };
			if (type === ExtensionsTab) return { value: "<!--extensions-tab-->" };
			if (type === PluginsTab) return { value: "<!--plugins-tab-->" };
			return undefined;
		},
	});
	setState("modal", originalModal);
});

afterAll(async () => {
	restoreJsxShim();
	await activateFeatures([...originalActive]);
	setState("integrations", "tab", originalTab);
	setState("modal", originalModal);
});

/** Render the dialog with exactly `features` active and `tab` stored. */
async function render(features: readonly FeatureId[], tab: IntegrationTab): Promise<string> {
	await activateFeatures(features);
	setState("integrations", "tab", tab);
	return renderToString(() => createComponent(IntegrationsDialog, { onClose: () => {} }));
}

const showsTab = (html: string, id: IntegrationTab) => html.includes(`id="integrations-tab-${id}"`);

describe("IntegrationsDialog with the plugins feature on", () => {
	test("lists both tabs and shows the stored Plugins one", async () => {
		const html = await render(["plugins"], "plugins");
		expect(showsTab(html, "extensions")).toBe(true);
		expect(showsTab(html, "plugins")).toBe(true);
		expect(html).toContain("<!--plugins-tab-->");
		expect(html).not.toContain("<!--extensions-tab-->");
		expect(html).toContain("settings-control-btn");
	});

	test("shows the Extensions body when Extensions is stored", async () => {
		const html = await render(["plugins"], "extensions");
		expect(showsTab(html, "plugins")).toBe(true);
		expect(html).toContain("<!--extensions-tab-->");
		expect(html).not.toContain("<!--plugins-tab-->");
	});
});

describe("IntegrationsDialog with the plugins feature off", () => {
	test("has no Plugins tab and no tab list, and shows Extensions even when Plugins is stored", async () => {
		const html = await render([], "plugins");
		expect(showsTab(html, "plugins")).toBe(false);
		expect(html).not.toContain('role="tablist"');
		expect(html).toContain("<!--extensions-tab-->");
		expect(html).not.toContain("<!--plugins-tab-->");
		expect(html).toContain("settings-control-btn");
	});
});

describe("the palette's Extensions entries", () => {
	test("Skills and MCP servers open the dialog on that group with no feature active", () => {
		const items = openItems({ debugEnabled: false, pluginsEnabled: false, projects: [] });
		setState("modal", null);
		runPaletteItem(items.find((item) => item.label === "MCP servers")!);
		expect(state.modal).toBe("integrations");
		expect(state.integrations.tab).toBe("extensions");
		expect(state.integrations.extensionsFocus).toBe("mcp");
		runPaletteItem(items.find((item) => item.label === "Skills")!);
		expect(state.integrations.extensionsFocus).toBe("skill");
	});

	test("Plugins opens the dialog on the Plugins tab", () => {
		const items = openItems({ debugEnabled: false, pluginsEnabled: true, projects: [] });
		setState("integrations", "tab", "extensions");
		runPaletteItem(items.find((item) => item.label === "Plugins")!);
		expect(state.modal).toBe("integrations");
		expect(state.integrations.tab).toBe("plugins");
	});
});
