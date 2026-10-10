import { SettingsModal } from "../../../web/components/settings/SettingsModal";
import { SettingsRowLayout, SettingsRow } from "../../../web/components/settings/SettingsRow";
import { SettingsNav, SettingsSectionPicker } from "../../../web/components/settings/SettingsNav";
import { WebUiSettings } from "../../../web/components/settings/WebUiSettings";
import {
	settingApiKey,
	settingAutoCompact,
	settingBashTimeout,
	settingEditMode,
	settingEnabledTools,
	settingEnvRecord,
	settingProviderLimits,
	settingSkillPaths,
	settingThinkingLevel,
	settingsModelCurrentSession,
	settingsModelSubsections,
	settingsSections,
} from "../../fixtures/overlays";
import { answerCalls } from "../../daemon";
import { defineStory } from "../../registry";

export default [
	defineStory({
		id: "settings-modal",
		title: "SettingsModal",
		component: { file: "apps/web/components/settings/SettingsModal.tsx", export: "SettingsModal" },
		tabs: true,
		seed: { currentSessionId: "sess_09a41c" },
		variants: [
			{
				name: "Session settings",
				description: "Current-session target, every section populated.",
				seed: () => answerCalls({ getSettings: () => settingsModelCurrentSession }),
				render: () => <SettingsModal onClose={() => undefined} />,
			},
			{
				name: "Loading",
				description: "getSettings has not answered yet.",
				seed: () =>
					answerCalls({
						getSettings: () => Promise.withResolvers<unknown>().promise,
					}),
				render: () => <SettingsModal onClose={() => undefined} />,
			},
			{
				name: "Load failed",
				seed: () =>
					answerCalls({
						getSettings: () => {
							throw new Error("settings.yml is locked by another omp process");
						},
					}),
				render: () => <SettingsModal onClose={() => undefined} />,
			},
		],
	}),
	defineStory({
		id: "settings-nav",
		title: "SettingsNav",
		component: { file: "apps/web/components/settings/SettingsNav.tsx", export: "SettingsNav" },
		variants: [
			{
				name: "Model section, Defaults group",
				render: () => (
					<SettingsNav
						sections={settingsSections}
						activeTabId="model"
						subsections={settingsModelSubsections}
						activeGroup="Defaults"
						onSelectTab={() => undefined}
						onSelectGroup={() => undefined}
					/>
				),
			},
			{
				name: "Web UI section",
				render: () => (
					<SettingsNav
						sections={settingsSections}
						activeTabId="web-ui"
						subsections={[]}
						activeGroup={null}
						onSelectTab={() => undefined}
						onSelectGroup={() => undefined}
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
						sections={settingsSections}
						activeTabId="model"
						onSelectTab={() => undefined}
					/>
				),
			},
			{
				name: "Web UI selected",
				render: () => (
					<SettingsSectionPicker
						sections={settingsSections}
						activeTabId="web-ui"
						onSelectTab={() => undefined}
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
				name: "Boolean with warning",
				render: () => <SettingsRow item={settingAutoCompact} />,
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
						<input type="checkbox" checked disabled />
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
						<input type="number" value="120" disabled />
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
				name: "All groups",
				render: () => <WebUiSettings model={settingsModelCurrentSession} visibleGroup={null} />,
			},
			{
				name: "Images group",
				render: () => <WebUiSettings model={settingsModelCurrentSession} visibleGroup="Images" />,
			},
		],
	}),
];
