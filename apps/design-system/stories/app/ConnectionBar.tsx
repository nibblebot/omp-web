import { ConnectionBar } from "../../../web/components/app/ConnectionBar";
import { ModalHost } from "../../../web/ModalHost";
import { Toasts } from "../../../web/components/app/Toasts";
import { dialClient } from "../../session";
import { defineStory } from "../../registry";

export default defineStory({
	id: "app-connection-bar",
	title: "ConnectionBar",
	component: { file: "apps/web/components/app/ConnectionBar.tsx", export: "ConnectionBar" },
	// The page's first dial is long past: with the startup hold on, the strip stays hidden until a grace ends.
	seed: { transportStartup: false, view: "chat", sidebarVisible: false },
	variants: [
		{
			name: "Reconnecting",
			description:
				"The browser socket cannot be dialed: the client's reconnect loop runs against a fake edge that refuses every dial, the strip says it is reconnecting and session actions are paused.",
			seed: () => dialClient("refuse"),
			render: () => <ConnectionBar />,
		},
		{
			name: "Signed out",
			description:
				"The edge closes the socket 4401: the client holds its reconnect, the strip stays up and the sign-in modal opens.",
			seed: () => dialClient({ close: "unauthorized", message: "session expired, sign in again" }),
			render: () => (
				<>
					<ConnectionBar />
					<ModalHost />
				</>
			),
		},
		{
			name: "Proto mismatch",
			description:
				"The edge closes the socket 4426: the client records the mismatch error and stops reconnecting. The strip asks for a reload and offers a Reload button (an installed window has no reload control); Toasts holds the error back while the strip is up.",
			seed: () => dialClient({ close: "proto_mismatch", message: "server speaks OMP_PROTO 7" }),
			render: () => (
				<>
					<ConnectionBar />
					<Toasts />
				</>
			),
		},
		{
			name: "Offline",
			description:
				"The attached session process is down: the strip says actions are paused until the session restarts.",
			seed: { connected: true, sessionDownId: "workspace-a", view: "chat", sidebarVisible: false },
			render: () => <ConnectionBar />,
		},
	],
});
