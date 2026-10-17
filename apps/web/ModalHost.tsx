import { For, Show, createEffect, type Component, type JSX } from "solid-js";
import { ShortcutsDialog } from "./components/app/ShortcutsDialog";
import { FleetSignInDialog } from "./components/app/FleetSignInDialog";
import { Toasts } from "./components/app/Toasts";
import { CompactionDialog } from "./components/chat/controls/CompactionDialog";
import { AddProjectDialog } from "./components/fleet/workspaces/AddProjectDialog";
import { AddRemoteDialog } from "./components/fleet/workspaces/AddRemoteDialog";
import { DeleteWorkspaceDialog } from "./components/fleet/workspaces/DeleteWorkspaceDialog";
import { RemoveProjectDialog } from "./components/fleet/workspaces/RemoveProjectDialog";
import { AddWorkspaceDialog } from "./components/fleet/workspaces/AddWorkspaceDialog";
import { DaemonDetailsDialog } from "./components/fleet/daemon/DaemonDetailsDialog";
import { ProviderLoginDialog } from "./components/models/ProviderLoginDialog";
import { ModelPicker } from "./components/models/ModelPicker";
import { ThinkingLevelPicker } from "./components/models/ThinkingLevelPicker";
import { ExtensionUi } from "./components/requests/ExtensionUi";
import { DangerConfirmDialog } from "./components/requests/DangerConfirmDialog";
import { DownloadDialog } from "./components/requests/DownloadDialog";
import { ResumePicker } from "./components/sessions/ResumePicker";
import { SessionPicker } from "./components/sessions/SessionPicker";
import { SettingsSheet } from "./components/settings/SettingsSheet";
import { SubagentsDialog } from "./components/subagents/SubagentsDialog";
import { ShareSheet } from "./components/collab/ShareSheet";
import { SessionStatsDialog } from "./components/usage/SessionStatsDialog";
import { UsageLimitsDialog } from "./components/usage/UsageLimitsDialog";
import { ImageLightbox } from "./components/ui/ImageLightbox";
import { featureModal, featureOverlays } from "./features/registry";
import { closeDaemonDetails, closeLightbox, setState, state, type ModalName } from "./state";
import { resumePickerOpen } from "./store/resume";

/**
 * Every overlay App mounts: the active `state.modal`, plus the dialogs that
 * mount once and render nothing until their own store state asks for them
 * (agent ask/confirm/download requests, extension UI, resume, fleet
 * confirmations, daemon details, the image lightbox, toasts). Overlays owned
 * by an enabled feature come from the feature registry.
 */
export const ModalHost: Component = () => {
	const close = () => setState("modal", null);
	// Roster-gated slot: the details dialog renders only while its daemon is in
	// the roster, and a daemon that leaves the fleet clears the slot (mirrors
	// RemoveProjectDialog's project lookup).
	const daemonDetails = () => {
		const id = state.daemonDetailsId;
		return id === null ? undefined : state.daemonRoster.find((d) => d.daemonId === id);
	};
	createEffect(() => {
		const id = state.daemonDetailsId;
		if (id !== null && !state.daemonRoster.some((d) => d.daemonId === id)) closeDaemonDetails();
	});
	// Renderer for a modal owned by a feature. Renders nothing when the feature
	// is disabled on this page, so a stale `state.modal` cannot mount feature UI.
	const featureModalHost = (name: ModalName): JSX.Element => {
		const Render = featureModal(name);
		return Render ? <Render onClose={close} /> : null;
	};
	// One renderer per `state.modal` value. `satisfies Record<ModalName, …>`
	// makes a modal without a renderer a type error, and object keys are
	// unique, so a modal can never be mounted twice.
	const modals = {
		help: () => <ShortcutsDialog initialTab="commands" onClose={close} />,
		hotkeys: () => <ShortcutsDialog initialTab="shortcuts" onClose={close} />,
		model: () => <ModelPicker onClose={close} />,
		thinking: () => <ThinkingLevelPicker onClose={close} />,
		stats: () => <SessionStatsDialog onClose={close} />,
		settings: () => <SettingsSheet onClose={close} />,
		sessions: () => <SessionPicker onClose={close} />,
		subagents: () => <SubagentsDialog onClose={close} />,
		login: () => <ProviderLoginDialog onClose={close} />,
		goal: () => featureModalHost("goal"),
		usage: () => <UsageLimitsDialog onClose={close} />,
		debug: () => featureModalHost("debug"),
		"add-project": () => <AddProjectDialog onClose={close} />,
		"add-remote": () => <AddRemoteDialog onClose={close} />,
		workspace: () => <AddWorkspaceDialog onClose={close} />,
		"sign-in": () => <FleetSignInDialog onClose={close} />,
		integrations: () => featureModalHost("integrations"),
		"plan-review": () => featureModalHost("plan-review"),
		annotations: () => featureModalHost("annotations"),
		todos: () => featureModalHost("todos"),
		compaction: () => <CompactionDialog onClose={close} />,
		share: () => <ShareSheet onClose={close} />,
		btw: () => featureModalHost("btw"),
	} satisfies Record<ModalName, () => JSX.Element>;
	return (
		<>
			<Show when={state.modal} keyed>
				{(name) => modals[name]()}
			</Show>
			<Show when={state.lightboxImage} keyed>
				{(img) => <ImageLightbox image={img} onClose={closeLightbox} />}
			</Show>
			<Show when={daemonDetails()}>
				{(daemon) => <DaemonDetailsDialog daemon={daemon()} onClose={closeDaemonDetails} />}
			</Show>
			<For each={featureOverlays()}>{(Overlay) => <Overlay />}</For>
			<ExtensionUi placement="modal" />
			<DownloadDialog />
			<DangerConfirmDialog />
			<Show when={resumePickerOpen()}>
				<ResumePicker onClose={() => undefined} />
			</Show>
			<DeleteWorkspaceDialog />
			<RemoveProjectDialog />
			<Toasts />
		</>
	);
};
