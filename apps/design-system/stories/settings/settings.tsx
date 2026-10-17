import { SettingsSheet } from "../../../web/components/settings/SettingsSheet";
import { SettingsRowLayout, SettingsRow } from "../../../web/components/settings/SettingsRow";
import { SettingsNav, SettingsSectionPicker } from "../../../web/components/settings/SettingsNav";
import { WebUiSettings } from "../../../web/components/settings/WebUiSettings";
import { SettingStepper } from "../../../web/components/settings/controls/SettingStepper";
import { SettingToggle } from "../../../web/components/settings/controls/SettingToggle";
import { setState } from "../../../web/state";
import { changedCountsByTab, SETTINGS_TABS } from "../../../web/prefs/settings-tabs";
import {
	modelInfos,
	modelRoleCatalog,
	settingApiKey,
	settingBashTimeout,
	settingEditMode,
	settingEnabledTools,
	settingEnvRecord,
	settingExternalThinking,
	settingProviderLimits,
	settingSkillPaths,
	settingThinkingLevel,
	settingThinkingLevelGlobal,
	settingsModelCurrentSession,
	settingsModelSections,
	settingsWebUiSections,
} from "../../fixtures/overlays";
import { answerCalls } from "../../daemon";
import { defineStory } from "../../registry";

export default [
	defineStory({
		id: "settings-sheet",
		title: "SettingsSheet",
		component: { file: "apps/web/components/settings/SettingsSheet.tsx", export: "SettingsSheet" },
		tabs: true,
		seed: { currentSessionId: "sess_09a41c" },
		variants: [
			{
				name: "Session settings",
				description: "Current-session target, every section populated.",
				seed: () => {
					answerCalls({
						getSettings: () => settingsModelCurrentSession,
						getModelBrowser: () => modelInfos,
					});
					setState("modelBrowser", modelInfos);
					setState("modelRoleCatalog", modelRoleCatalog);
					setState("thinkingSelectors", ["off", "minimal", "low", "medium", "high", "xhigh"]);
				},
				render: (ctx) => <SettingsSheet onClose={ctx.close} />,
			},
			{
				name: "Loading",
				description: "getSettings has not answered yet.",
				seed: () =>
					answerCalls({
						getSettings: () => Promise.withResolvers<unknown>().promise,
					}),
				render: (ctx) => <SettingsSheet onClose={ctx.close} />,
			},
			{
				name: "Load failed",
				seed: () =>
					answerCalls({
						getSettings: () => {
							throw new Error("settings.yml is locked by another omp process");
						},
					}),
				render: (ctx) => <SettingsSheet onClose={ctx.close} />,
			},
		],
	}),
	defineStory({
		id: "settings-nav",
		title: "SettingsNav",
		component: { file: "apps/web/components/settings/SettingsNav.tsx", export: "SettingsNav" },
		variants: [
			{
				name: "Model selected, Defaults section",
				render: () => (
					<SettingsNav
						tabs={SETTINGS_TABS}
						activeTabId="model"
						changedCounts={changedCountsByTab(settingsModelCurrentSession)}
						sections={settingsModelSections}
						onSelectTab={() => undefined}
						onSelectSection={() => undefined}
					/>
				),
			},
			{
				name: "Web UI selected",
				render: () => (
					<SettingsNav
						tabs={SETTINGS_TABS}
						activeTabId="web-ui"
						changedCounts={new Map()}
						sections={settingsWebUiSections}
						onSelectTab={() => undefined}
						onSelectSection={() => undefined}
					/>
				),
			},
		],
	}),
	defineStory({
		id: "settings-section-picker",
		title: "SettingsSectionPicker",
		component: {
			file: "apps/web/components/settings/SettingsNav.tsx",
			export: "SettingsSectionPicker",
		},
		variants: [
			{
				name: "Model selected",
				render: () => (
					<SettingsSectionPicker
						tabs={SETTINGS_TABS}
						activeTabId="model"
						sections={[
							{ id: "model-roles", label: "Model roles" },
							{ id: "model-providers", label: "Providers" },
						]}
						onSelectTab={() => undefined}
						onSelectSection={() => undefined}
					/>
				),
			},
			{
				name: "Web UI selected",
				render: () => (
					<SettingsSectionPicker
						tabs={SETTINGS_TABS}
						activeTabId="web-ui"
						sections={[
							{ id: "web-interface", label: "Interface" },
							{ id: "web-session", label: "Session" },
						]}
						onSelectTab={() => undefined}
						onSelectSection={() => undefined}
					/>
				),
			},
		],
	}),
	defineStory({
		id: "settings-row",
		title: "SettingsRow",
		component: { file: "apps/web/components/settings/SettingsRow.tsx", export: "SettingsRow" },
		variants: [
			{
				name: "Enum: thinking level",
				render: () => <SettingsRow item={settingThinkingLevel} />,
			},
			{
				name: "Enum: thinking level, default role has a suffix",
				description:
					"Role default carries :high; the row shows the SET-03 note, the value is unchanged.",
				seed: () => {
					setState("modelRoleCatalog", modelRoleCatalog);
				},
				render: () => <SettingsRow item={settingThinkingLevel} />,
			},
			{
				name: "Enum: thinking level, explicit global",
				description: "Changed value written to the global layer; Reset is offered.",
				render: () => <SettingsRow item={settingThinkingLevelGlobal} />,
			},
			{
				name: "Boolean with warning",
				render: () => <SettingsRow item={settingExternalThinking} />,
			},
			{
				name: "Submenu: edit mode",
				render: () => <SettingsRow item={settingEditMode} />,
			},
			{
				name: "Text input",
				render: () => <SettingsRow item={settingBashTimeout} />,
			},
			{
				name: "Secret text",
				render: () => <SettingsRow item={settingApiKey} />,
			},
			{
				name: "Ordered multiselect",
				render: () => <SettingsRow item={settingEnabledTools} />,
			},
			{
				name: "Provider limits",
				render: () => <SettingsRow item={settingProviderLimits} />,
			},
			{
				name: "Record editor",
				render: () => <SettingsRow item={settingEnvRecord} />,
			},
			{
				name: "List editor",
				render: () => <SettingsRow item={settingSkillPaths} />,
			},
		],
	}),
	defineStory({
		id: "settings-row-layout",
		title: "SettingsRowLayout",
		component: {
			file: "apps/web/components/settings/SettingsRow.tsx",
			export: "SettingsRowLayout",
		},
		variants: [
			{
				name: "Plain",
				render: () => (
					<SettingsRowLayout label="Auto-compact">
						<SettingToggle label="Auto-compact" checked disabled onChange={() => undefined} />
					</SettingsRowLayout>
				),
			},
			{
				name: "Changed, with description",
				render: () => (
					<SettingsRowLayout
						label="Bash timeout"
						description="Seconds before a foreground bash call is cancelled."
						changed
					>
						<SettingStepper
							label="Bash timeout"
							path="bash.timeoutSec"
							value={120}
							onChange={() => Promise.resolve(true)}
						/>
					</SettingsRowLayout>
				),
			},
		],
	}),
	defineStory({
		id: "settings-web-ui-settings",
		title: "WebUiSettings",
		component: { file: "apps/web/components/settings/WebUiSettings.tsx", export: "WebUiSettings" },
		variants: [
			{
				name: "All sections",
				render: () => <WebUiSettings />,
			},
		],
	}),
];
