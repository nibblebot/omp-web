import { DialogActions } from "../../../web/components/ui/DialogActions";
import { defineStory } from "../../registry";

export default defineStory({
	id: "ui-dialog-actions",
	title: "DialogActions",
	component: { file: "apps/web/components/ui/DialogActions.tsx", export: "DialogActions" },
	variants: [
		{
			name: "Save or cancel",
			description: "The default primary action with a cancel button.",
			render: () => (
				<DialogActions
					onCancel={() => undefined}
					onPrimary={() => undefined}
					primaryLabel="Save changes"
					cancelLabel="Cancel"
				/>
			),
		},
		{
			name: "Destructive",
			description: "primaryDanger swaps the primary button to the danger style.",
			render: () => (
				<DialogActions
					onCancel={() => undefined}
					onPrimary={() => undefined}
					primaryLabel="Delete session"
					cancelLabel="Keep session"
					primaryDanger
				/>
			),
		},
		{
			name: "Busy",
			description: "busy while a sign-in request is in flight.",
			render: () => (
				<DialogActions
					onCancel={() => undefined}
					onPrimary={() => undefined}
					primaryLabel="Sign in"
					cancelLabel="Cancel"
					busy
				/>
			),
		},
		{
			name: "Primary disabled",
			description: "primaryDisabled while the required field is still empty.",
			render: () => (
				<DialogActions
					onCancel={() => undefined}
					onPrimary={() => undefined}
					primaryLabel="Sign in"
					cancelLabel="Cancel"
					primaryDisabled
				/>
			),
		},
		{
			name: "Cancel only",
			description: "Without onPrimary, only the cancel button renders.",
			render: () => <DialogActions onCancel={() => undefined} cancelLabel="Close" />,
		},
	],
});
