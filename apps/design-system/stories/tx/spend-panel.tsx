import { SpendPanel } from "../../../web/tx/components/SpendPanel";
import { health, healthMissingDb } from "../../fixtures/tx";
import { defineStory } from "../../registry";

/** Health before any sync has landed: the footer says "Not synced yet". */
const neverSynced = { ...health, lastSyncedAt: null };

export default [
	defineStory({
		id: "tx-spend-panel",
		title: "SpendPanel",
		component: {
			file: "apps/web/tx/components/SpendPanel.tsx",
			export: "SpendPanel",
		},
		variants: [
			{
				name: "Synced",
				render: () => <SpendPanel health={() => health} syncTick={() => 0} />,
			},
			{
				name: "Never synced",
				render: () => <SpendPanel health={() => neverSynced} syncTick={() => 0} />,
			},
			{
				name: "Stats DB missing",
				render: () => <SpendPanel health={() => healthMissingDb} syncTick={() => 0} />,
			},
		],
	}),
];
