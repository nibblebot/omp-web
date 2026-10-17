import { For, Show, type Component } from "solid-js";
import { QrCode, renderQrText } from "@oh-my-pi/pi-tui/chrome/qrcode";
import { state } from "../../state";
import {
	PUBLIC_RELAY_URL,
	relayConfigured,
	startCollabRoom,
	stopCollabRoom,
} from "../../store/collab";
import type { CollabParticipantInfo } from "#lib/wire/protocol";
import { CopyButton } from "../ui/CopyButton";
import { Modal } from "../ui/Modal";

type LiveStatus = Extract<typeof state.collabStatus, { state: "live" }>;

/**
 * Share sheet: start or stop sharing the attached session, copy the guest
 * links, show the roster. With no `collab.relayUrl` configured, the public
 * relay opt-in (with its disclosure) is shown before any click.
 */
export const ShareSheet: Component<{ onClose: () => void }> = (props) => {
	const liveStatus = (): LiveStatus | null =>
		state.collabStatus.state === "live" ? state.collabStatus : null;
	const errorText = (): string | null =>
		state.collabStatus.state === "error" ? state.collabStatus.error : null;
	return (
		<Modal title="Share session" onClose={props.onClose} class="share-sheet">
			<Show when={liveStatus()}>{(live) => <LivePanel live={live()} />}</Show>
			<Show when={state.collabStatus.state === "starting"}>
				<p class="share-note">Starting the room…</p>
			</Show>
			<Show when={errorText()}>
				{(error) => (
					<p class="share-error" role="alert">
						{error()}
					</p>
				)}
			</Show>
			<Show when={state.collabStatus.state === "off" || state.collabStatus.state === "error"}>
				<Show when={relayConfigured()} fallback={<RelayOptIn />}>
					<StartChoices />
				</Show>
			</Show>
		</Modal>
	);
};

const StartChoices: Component = () => (
	<div class="share-start">
		<p class="share-note">
			Guests join with a link. View-only guests can watch; control guests can prompt.
		</p>
		<div class="share-actions">
			<button type="button" class="share-btn" onClick={() => startCollabRoom("view")}>
				Share, view only
			</button>
			<button type="button" class="share-btn" onClick={() => startCollabRoom("control")}>
				Share, guests can control
			</button>
		</div>
	</div>
);

const RelayOptIn: Component = () => (
	<div class="share-optin">
		<h3 class="share-optin-title">No relay is configured</h3>
		<p class="share-note">
			Sharing needs a relay. You can run your own and set <code>collab.relayUrl</code> in settings.
			Or use the public relay ({PUBLIC_RELAY_URL}).
		</p>
		<p class="share-disclosure">
			The public relay sees room ids, connections, IP addresses, timing and frame sizes. It does not
			see message content.
		</p>
		<div class="share-actions">
			<button
				type="button"
				class="share-btn"
				onClick={() => startCollabRoom("view", PUBLIC_RELAY_URL)}
			>
				Use public relay, view only
			</button>
			<button
				type="button"
				class="share-btn"
				onClick={() => startCollabRoom("control", PUBLIC_RELAY_URL)}
			>
				Use public relay, guests can control
			</button>
		</div>
	</div>
);

const LivePanel: Component<{ live: LiveStatus }> = (props) => {
	const guests = () => props.live.participants.filter((p) => p.role === "guest");
	return (
		<div class="share-live">
			<p class="share-live-head">
				<span class="share-live-dot" aria-hidden="true" />
				Live · {guests().length} guest{guests().length === 1 ? "" : "s"} ·{" "}
				{props.live.access === "control" ? "guests can control" : "view only"}
			</p>
			<LinkRow
				label={props.live.access === "control" ? "Control link" : "Guest link (view only)"}
				value={props.live.link}
			/>
			<Show when={props.live.access === "control"}>
				<LinkRow label="View-only link" value={props.live.viewLink} />
			</Show>
			<Show when={props.live.browserLink}>
				{(url) => (
					<>
						<LinkRow label="Browser link" value={url()} />
						<QrBlock label="QR code for the browser link" text={url()} />
					</>
				)}
			</Show>
			<LinkRow label="Join from a terminal" value={`omp join ${props.live.link}`} />
			<Roster participants={props.live.participants} />
			<button type="button" class="share-btn share-stop" onClick={() => stopCollabRoom()}>
				Stop sharing
			</button>
			<p class="share-note">Stopping ends the room and disconnects every guest.</p>
		</div>
	);
};

const LinkRow: Component<{ label: string; value: string }> = (props) => (
	<div class="share-link-row">
		<span class="share-link-label">{props.label}</span>
		<input class="share-link-input" readOnly value={props.value} aria-label={props.label} />
		<CopyButton class="share-copy-btn" title={`Copy ${props.label}`} text={() => props.value} />
	</div>
);

const QrBlock: Component<{ label: string; text: string }> = (props) => (
	<pre class="share-qr" role="img" aria-label={props.label}>
		{renderQrText(QrCode.encodeText(props.text, "M"), false).join("\n")}
	</pre>
);

const Roster: Component<{ participants: CollabParticipantInfo[] }> = (props) => (
	<ul class="share-roster" aria-label="Participants">
		<For each={props.participants}>
			{(p) => (
				<li class="share-roster-row">
					<span class="share-roster-name">{p.name}</span>
					<span class="share-roster-role">
						{p.role === "host" ? "host" : p.readOnly ? "view only" : "guest"}
					</span>
				</li>
			)}
		</For>
	</ul>
);
