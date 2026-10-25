import type { CollabStatus } from "../../web/store/slices/collab";

/** A live collab room with the host and two guests, one read-only. */
export const liveCollabStatus: CollabStatus = {
	state: "live",
	link: "wss://relay.example/r/9f2c#control",
	viewLink: "wss://relay.example/r/9f2c#view",
	browserLink: "https://my.omp.sh/join/9f2c#control",
	browserViewLink: "https://my.omp.sh/join/9f2c#view",
	access: "control",
	relayUrl: "wss://relay.example",
	roomId: "9f2c",
	maxGuests: 4,
	participants: [
		{ name: "joshua", role: "host" },
		{ name: "ada", role: "guest" },
		{ name: "lin", role: "guest", readOnly: true },
	],
};
