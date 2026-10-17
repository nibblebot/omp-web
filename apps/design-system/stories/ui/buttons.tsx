import { ConfirmButton } from "../../../web/components/ui/ConfirmButton";
import { CopyButton } from "../../../web/components/ui/CopyButton";
import { StopIcon, TrashIcon } from "../../../web/components/ui/icons";
import { defineStory } from "../../registry";

/** Every button primitive from components/ui on one page, in its own nav section. */
export default defineStory({
	id: "buttons",
	title: "Buttons",
	section: "Buttons",
	component: [
		{ file: "apps/web/components/ui/ConfirmButton.tsx", export: "ConfirmButton" },
		{ file: "apps/web/components/ui/CopyButton.tsx", export: "CopyButton" },
	],
	variants: [
		{
			name: "ConfirmButton: two-click stop",
			description:
				"The first click arms and relabels the button. The second click fires onConfirm. The arm disarms after 4 seconds.",
			render: () => (
				<ConfirmButton
					label="Stop session process"
					confirmLabel="Confirm stop"
					onConfirm={() => undefined}
				>
					<StopIcon />
				</ConfirmButton>
			),
		},
		{
			name: "ConfirmButton: menu item",
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
			name: "ConfirmButton: short arm timeout",
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
			name: "ConfirmButton: disabled",
			description: "A disabled button cannot arm.",
			render: () => (
				<ConfirmButton
					label="Stop session process"
					confirmLabel="Confirm stop"
					disabled
					onConfirm={() => undefined}
				/>
			),
		},
		{
			name: "CopyButton: default",
			description: "Click to copy; the label flips to copied for 1.2s.",
			render: () => <CopyButton text="omp --resume 2026-10-09T11-42-17Z_a1b2c3.jsonl" />,
		},
		{
			name: "CopyButton: message toolbar",
			description: "The production styling used on chat message cards.",
			render: () => (
				<CopyButton
					class="msg-copy-btn"
					title="Copy message markdown"
					text={() => "Resolved at click time, so streaming text is never stale."}
				/>
			),
		},
	],
});
