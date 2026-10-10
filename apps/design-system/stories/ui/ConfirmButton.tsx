import { ConfirmButton } from "../../../web/components/ui/ConfirmButton";
import { StopIcon, TrashIcon } from "../../../web/components/ui/icons";
import { defineStory } from "../../registry";

export default defineStory({
	id: "ui-confirm-button",
	title: "ConfirmButton",
	component: { file: "apps/web/components/ui/ConfirmButton.tsx", export: "ConfirmButton" },
	variants: [
		{
			name: "Two-click stop",
			description:
				"The first click arms and relabels the button. The second click fires onConfirm. The arm disarms after 4 seconds.",
			render: () => (
				<ConfirmButton label="Stop daemon" confirmLabel="Confirm stop" onConfirm={() => undefined}>
					<StopIcon />
				</ConfirmButton>
			),
		},
		{
			name: "Menu item",
			description: "role=menuitem inside a role=menu dropdown, as used by the sidebar row actions.",
			render: () => (
				<div class="sidebar-menu" role="menu">
					<ConfirmButton
						role="menuitem"
						class="sidebar-menu-item"
						label="Delete session"
						confirmLabel="Confirm delete"
						onConfirm={() => undefined}
					>
						<TrashIcon />
					</ConfirmButton>
				</div>
			),
		},
		{
			name: "Short arm timeout",
			description:
				"timeoutMs 1500: the armed state disarms quickly if the second click is not made.",
			render: () => (
				<ConfirmButton
					label="Reset worktree"
					confirmLabel="Confirm reset"
					timeoutMs={1500}
					onConfirm={() => undefined}
				/>
			),
		},
		{
			name: "Disabled",
			description: "A disabled button cannot arm.",
			render: () => (
				<ConfirmButton
					label="Stop daemon"
					confirmLabel="Confirm stop"
					disabled
					onConfirm={() => undefined}
				/>
			),
		},
	],
});
