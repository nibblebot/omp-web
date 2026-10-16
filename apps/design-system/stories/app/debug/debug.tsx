import { DebugButton } from "../../../../web/components/app/debug/DebugButton";
import { FleetDebugSheet } from "../../../../web/components/app/debug/FleetDebugSheet";
import { LastFrameClock } from "../../../../web/components/app/debug/LastFrameClock";
import { DebugLog } from "../../../../web/components/app/debug/DebugLog";
import { setState } from "../../../../web/state";
import { debugLogEntries, debugLogReconnecting, fleetLogEntries } from "../../../fixtures/dialogs";
import { defineStory } from "../../../registry";

export default [
	defineStory({
		id: "app-fleet-debug-sheet",
		title: "FleetDebugSheet",
		component: {
			file: "apps/web/components/app/debug/FleetDebugSheet.tsx",
			export: "FleetDebugSheet",
		},
		tabs: true,
		variants: [
			{
				name: "Connected with log",
				seed: {
					connected: true,
					currentSessionId: "sess_9d2c",
					reconnectDelay: 0,
					debugLog: debugLogEntries,
				},
				render: (ctx) => <FleetDebugSheet onClose={ctx.close} />,
			},
			{
				name: "Reconnecting",
				seed: {
					connected: false,
					currentSessionId: "sess_9d2c",
					reconnectDelay: 4000,
					debugLog: debugLogReconnecting,
				},
				render: (ctx) => <FleetDebugSheet onClose={ctx.close} />,
			},
			{
				name: "No session attached",
				seed: { connected: false, currentSessionId: "", reconnectDelay: 0, debugLog: [] },
				render: (ctx) => <FleetDebugSheet onClose={ctx.close} />,
			},
		],
	}),
	defineStory({
		id: "app-debug-last-frame-clock",
		title: "LastFrameClock",
		component: {
			file: "apps/web/components/app/debug/LastFrameClock.tsx",
			export: "LastFrameClock",
		},
		variants: [
			{
				name: "No frame yet",
				seed: () => setState("lastFrameAt", 0),
				render: () => <LastFrameClock />,
			},
			{
				name: "Just now",
				seed: () => setState("lastFrameAt", Date.now()),
				render: () => <LastFrameClock />,
			},
			{
				name: "Stalled 42 s",
				seed: () => setState("lastFrameAt", Date.now() - 42_000),
				render: () => <LastFrameClock />,
			},
		],
	}),
	defineStory({
		id: "app-debug-log",
		title: "DebugLog",
		component: { file: "apps/web/components/app/debug/DebugLog.tsx", export: "DebugLog" },
		variants: [
			{
				name: "Fleet events",
				render: () => <DebugLog entries={() => fleetLogEntries} empty="No fleet events yet." />,
			},
			{
				name: "Empty",
				render: () => <DebugLog entries={() => []} empty="No fleet events yet." />,
			},
		],
	}),
	defineStory({
		id: "app-debug-button",
		title: "DebugButton",
		component: {
			file: "apps/web/components/app/debug/DebugButton.tsx",
			export: "DebugButton",
		},
		variants: [
			{ name: "Closed", seed: { modal: null }, render: () => <DebugButton /> },
			{
				name: "Sheet open",
				description: "Active while the debug sheet is the open modal.",
				seed: { modal: "debug" },
				render: () => <DebugButton />,
			},
		],
	}),
];
