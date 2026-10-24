import { SettingsSheet } from "../../../web/components/settings/SettingsSheet";
import { SettingsRowLayout, SettingsRow } from "../../../web/components/settings/SettingsRow";
import { SettingsNav, SettingsSectionPicker } from "../../../web/components/settings/SettingsNav";
import { WebUiSettings } from "../../../web/components/settings/WebUiSettings";
import { SettingStepper } from "../../../web/components/settings/controls/SettingStepper";
import { SettingToggle } from "../../../web/components/settings/controls/SettingToggle";
import { ResetIcon } from "../../../web/components/ui/icons";
import { setState } from "../../../web/state";
import {
	changedCountsByTab,
	SETTINGS_TABS,
	visibleSettingsTabs,
} from "../../../web/prefs/settings-tabs";
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
	settingsModel,
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
				name: "Session attached",
				description: "Current-session target, every section populated, This Session tab first.",
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
				name: "No session attached",
				description:
					"The fleet fallback: no This Session tab, no Login row, changes save to config.yml.",
				seed: () => {
					setState("currentSessionId", "");
					setState("settingsModel", settingsModel);
				},
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
				description:
					"The current tab's sections sit beneath it; the section the stream is at is current.",
				render: () => (
					<SettingsNav
						tabs={SETTINGS_TABS}
						activeTabId="model"
						activeSectionId={settingsModelSections[0]?.id}
						changedCounts={changedCountsByTab(settingsModelCurrentSession)}
						sections={settingsModelSections}
						onSelectTab={() => undefined}
						onSelectSection={() => undefined}
					/>
				),
			},
			{
				name: "This Session selected",
				description: "The session tab leads with no section label above it.",
				render: () => (
					<SettingsNav
						tabs={SETTINGS_TABS}
						activeTabId="session"
						changedCounts={new Map()}
						sections={[]}
						onSelectTab={() => undefined}
						onSelectSection={() => undefined}
					/>
				),
			},
			{
				name: "Appearance selected",
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
			{
				name: "No session attached",
				description: "Without a session the session tab is gone and `omp` heads the list.",
				render: () => (
					<SettingsNav
						tabs={visibleSettingsTabs(settingsModelCurrentSession, false)}
						activeTabId="appearance"
						changedCounts={changedCountsByTab(settingsModelCurrentSession)}
						sections={[]}
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
						activeSectionId="model-providers"
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
				name: "Appearance selected, before the first section",
				render: () => (
					<SettingsSectionPicker
						tabs={SETTINGS_TABS}
						activeTabId="web-ui"
						sections={settingsWebUiSections}
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
					<SettingsRowLayout label="Auto-Compact">
						<SettingToggle label="Auto-Compact" checked disabled onChange={() => undefined} />
					</SettingsRowLayout>
				),
			},
			{
				name: "Changed, with description and reset",
				description:
					"The reset icon button sits left of the control; the changed dot marks the label.",
				render: () => (
					<SettingsRowLayout
						label="Bash Timeout"
						description="Seconds before a foreground bash call is cancelled."
						changed
						reset={
							<button
								type="button"
								class="settings-reset"
								aria-label="Reset to default"
								title="Reset to default"
							>
								<ResetIcon />
							</button>
						}
					>
						<SettingStepper
							label="Bash Timeout"
							path="bash.timeoutSec"
							value={120}
							onChange={() => Promise.resolve(true)}
						/>
					</SettingsRowLayout>
				),
			},
			{
				name: "With note",
				description: "The muted suffix ends the description line; it is always visible.",
				render: () => (
					<SettingsRowLayout
						label="Plan Mode On Startup"
						description="Start new sessions in plan mode."
						note="New sessions only."
					>
						<SettingToggle
							label="Plan Mode On Startup"
							checked={false}
							onChange={() => undefined}
						/>
					</SettingsRowLayout>
				),
			},
			{
				name: "Note without description",
				render: () => (
					<SettingsRowLayout label="Default Thinking Level" note="New sessions only.">
						<SettingToggle label="Default Thinking Level" checked onChange={() => undefined} />
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
				name: "Interface only",
				description: "Signed out or auth disabled: no Account group.",
				render: () => <WebUiSettings />,
			},
			{
				name: "Interface and Account",
				description: "Signed in: Sign Out sits under Account.",
				seed: { authStatus: "signedIn" },
				render: () => <WebUiSettings />,
			},
			{
				name: "Two-line session titles on",
				description: "Roster rows may show two lines of the last session title.",
				seed: { sidebarSessionTitleLines: 2 },
				render: () => <WebUiSettings />,
			},
			{
				name: "Title-first workspace rows on",
				description: "Roster rows lead with the last session title.",
				seed: { sidebarTitleFirst: true },
				render: () => <WebUiSettings />,
			},
		],
	}),
];
