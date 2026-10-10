import { Show, createEffect, type Component, type JSX } from "solid-js";
import { FleetDebugSheet } from "./components/app/debug/FleetDebugSheet";
import { ShortcutsDialog } from "./components/app/ShortcutsDialog";
import { FleetSignInDialog } from "./components/app/FleetSignInDialog";
import { Toasts } from "./components/app/Toasts";
import { PromptHistoryPicker } from "./components/chat/composer/PromptHistoryPicker";
import { VoiceControls } from "./components/chat/composer/VoiceControls";
import { CompactionDialog } from "./components/chat/controls/CompactionDialog";
import { GoalDialog } from "./components/chat/controls/GoalDialog";
import { AddProjectDialog } from "./components/fleet/workspaces/AddProjectDialog";
import { DeleteWorkspaceDialog } from "./components/fleet/workspaces/DeleteWorkspaceDialog";
import { RemoveProjectDialog } from "./components/fleet/workspaces/RemoveProjectDialog";
import { AddWorkspaceDialog } from "./components/fleet/workspaces/AddWorkspaceDialog";
import { DaemonDetailsDialog } from "./components/fleet/daemon/DaemonDetailsDialog";
import { ProviderLoginDialog } from "./components/models/ProviderLoginDialog";
import { ModelPicker } from "./components/models/ModelPicker";
import { ThinkingLevelPicker } from "./components/models/ThinkingLevelPicker";
import { AskDialog } from "./components/requests/AskDialog";
import { ExtensionUi } from "./components/requests/ExtensionUi";
import { BtwSheet } from "./components/requests/BtwSheet";
import { DangerConfirmDialog } from "./components/requests/DangerConfirmDialog";
import { DownloadDialog } from "./components/requests/DownloadDialog";
import { AnnotationsPanel } from "./components/review/AnnotationsPanel";
import { GitPanel } from "./components/review/GitPanel";
import { PlanReviewPanel } from "./components/review/PlanReviewPanel";
import { TodoPanel } from "./components/review/TodoPanel";
import { SessionGraphDialog } from "./components/sessions/SessionGraphDialog";
import { BtwHistorySheet } from "./components/sessions/BtwHistorySheet";
import { ResumePicker } from "./components/sessions/ResumePicker";
import { SessionPicker } from "./components/sessions/SessionPicker";
import { McpServersDialog } from "./components/settings/integrations/McpServersDialog";
import { SkillsDialog } from "./components/settings/integrations/SkillsDialog";
import { SettingsSheet } from "./components/settings/SettingsSheet";
import { SubagentsDialog } from "./components/subagents/SubagentsDialog";
import { SessionStatsDialog } from "./components/usage/SessionStatsDialog";
import { UsageLimitsDialog } from "./components/usage/UsageLimitsDialog";
import { ImageLightbox } from "./components/ui/ImageLightbox";
import { Modal } from "./components/ui/Modal";
import { closeDaemonDetails, closeLightbox, setState, state, type ModalName } from "./state";
import { resumePickerOpen } from "./store/resume";

/**
 * Every overlay App mounts: the active `state.modal`, plus the dialogs that
 * mount once and render nothing until their own store state asks for them
 * (agent ask/confirm/download requests, extension UI, /btw, resume, fleet
 * confirmations, daemon details, the image lightbox, toasts).
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
	// One renderer per `state.modal` value. `satisfies Record<ModalName, …>`
	// makes a modal without a renderer a type error, and object keys are
	// unique, so a modal can never be mounted twice.
	const modals = {
		help: () => <ShortcutsDialog onClose={close} />,
		model: () => <ModelPicker onClose={close} />,
		thinking: () => <ThinkingLevelPicker onClose={close} />,
		stats: () => <SessionStatsDialog onClose={close} />,
		settings: () => <SettingsSheet onClose={close} />,
		sessions: () => <SessionPicker onClose={close} />,
		branch: () => <SessionGraphDialog onClose={close} />,
		history: () => <PromptHistoryPicker onClose={close} />,
		subagents: () => <SubagentsDialog onClose={close} />,
		login: () => <ProviderLoginDialog onClose={close} />,
		goal: () => <GoalDialog onClose={close} />,
		usage: () => <UsageLimitsDialog onClose={close} />,
		debug: () => <FleetDebugSheet onClose={close} />,
		"add-project": () => <AddProjectDialog onClose={close} />,
		workspace: () => <AddWorkspaceDialog onClose={close} />,
		"sign-in": () => <FleetSignInDialog onClose={close} />,
		mcp: () => <McpServersDialog onClose={close} />,
		skills: () => <SkillsDialog onClose={close} />,
		git: () => (
			<Modal variant="sheet" title="Git review" class="review-sheet" onClose={close}>
				<GitPanel />
			</Modal>
		),
		"plan-review": () => (
			<Modal variant="sheet" title="Plan review" class="review-sheet" onClose={close}>
				<PlanReviewPanel />
			</Modal>
		),
		annotations: () => (
			<Modal variant="sheet" title="Annotations" class="review-sheet" onClose={close}>
				<AnnotationsPanel />
			</Modal>
		),
		todos: () => (
			<Modal variant="sheet" title="Todos" class="review-sheet" onClose={close}>
				<TodoPanel />
			</Modal>
		),
		compaction: () => <CompactionDialog onClose={close} />,
		"btw-history": () => <BtwHistorySheet onClose={close} />,
		voice: () => (
			<Modal title="Voice" onClose={close}>
				<Show
					when={state.sessionScope}
					keyed
					fallback={<div class="msg-notice">Attach a session before using voice.</div>}
				>
					{(scope) => <VoiceControls scope={scope} />}
				</Show>
			</Modal>
		),
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
			<AskDialog />
			<BtwSheet />
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
