import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { ExtensionsTab } from "../../components/settings/integrations/ExtensionsTab";
import { IntegrationsDialog } from "../../components/settings/integrations/IntegrationsDialog";
import { PluginsTab } from "../../components/settings/integrations/PluginsTab";
import { Modal } from "../../components/ui/Modal";
import { FEATURE_IDS, type FeatureId } from "../../features/manifest";
import { markFeaturesActive } from "../../features/preferences";
import { isFeatureEnabled } from "../../features/registry";
import { openItems } from "../../palette/palette";
import { setState, state } from "../../state";
import type { IntegrationTab } from "../../store/slices/integrations";
import { runPaletteItem } from "../../store/palette";
import { installJsxShim, restoreJsxShim } from "../web.testkit";

/**
 * The Extensions dialog is shared by the `integrations` (Extensions tab) and
 * `plugins` (Plugins tab) features. Rendered through solid's SSR runtime with
 * the Modal shell and both tab bodies replaced by markers, so only the dialog's
 * own composition is asserted.
 */

const originalActive = new Set<FeatureId>(FEATURE_IDS.filter(isFeatureEnabled));
const originalTab = state.integrations.tab;
const originalModal = state.modal;

let title: unknown;

beforeEach(() => {
	restoreJsxShim();
	title = undefined;
	installJsxShim({
		onElement(type, props) {
			if (type === Modal) {
				title = props.title;
				return { value: props.children };
			}
			if (type === ExtensionsTab) return { value: "<!--extensions-tab-->" };
			if (type === PluginsTab) return { value: "<!--plugins-tab-->" };
			return undefined;
		},
	});
	setState("modal", originalModal);
});

afterAll(() => {
	restoreJsxShim();
	markFeaturesActive(originalActive);
	setState("integrations", "tab", originalTab);
	setState("modal", originalModal);
});

/** Render the dialog with exactly `features` active and `tab` stored. */
function render(features: readonly FeatureId[], tab: IntegrationTab): string {
	markFeaturesActive(features);
	setState("integrations", "tab", tab);
	return renderToString(() => createComponent(IntegrationsDialog, { onClose: () => {} }));
}

const showsTab = (html: string, id: IntegrationTab) => html.includes(`id="integrations-tab-${id}"`);

describe("IntegrationsDialog with both features on", () => {
	test("lists both tabs and shows the stored one", () => {
		const html = render(["integrations", "plugins"], "plugins");
		expect(showsTab(html, "extensions")).toBe(true);
		expect(showsTab(html, "plugins")).toBe(true);
		expect(html).toContain("<!--plugins-tab-->");
		expect(html).not.toContain("<!--extensions-tab-->");
		expect(html).toContain("settings-control-btn");
	});
});

describe("IntegrationsDialog with only plugins on", () => {
	test("shows the Plugins body without a tab list or reload, even when Extensions is stored", () => {
		const html = render(["plugins"], "extensions");
		expect(html).toContain("<!--plugins-tab-->");
		expect(html).not.toContain("<!--extensions-tab-->");
		expect(html).not.toContain('role="tablist"');
		expect(html).not.toContain("settings-control-btn");
	});

	test("the title names the plugins, not the extensions", () => {
		render(["plugins"], "plugins");
		const pluginsTitle = title;
		render(["integrations"], "extensions");
		expect(pluginsTitle).not.toBe(title);
	});
});

describe("IntegrationsDialog with only integrations on", () => {
	test("shows the Extensions body and reload, even when Plugins is stored", () => {
		const html = render(["integrations"], "plugins");
		expect(html).toContain("<!--extensions-tab-->");
		expect(html).not.toContain("<!--plugins-tab-->");
		expect(html).not.toContain('role="tablist"');
		expect(html).toContain("settings-control-btn");
	});
});

describe("the palette's Plugins entry", () => {
	test("opens the dialog on the Plugins tab", () => {
		const items = openItems({
			debugEnabled: false,
			integrationsEnabled: false,
			pluginsEnabled: true,
			projects: [],
		});
		setState("integrations", "tab", "extensions");
		runPaletteItem(items.find((item) => item.label === "Plugins")!);
		expect(state.modal).toBe("integrations");
		expect(state.integrations.tab).toBe("plugins");
	});
});
