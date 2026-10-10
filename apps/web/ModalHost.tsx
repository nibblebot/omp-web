import { Show, type Component, type JSX } from "solid-js";
import { FleetDebugModal } from "./components/app/debug/FleetDebugModal";
import { ShortcutsModal } from "./components/app/ShortcutsModal";
import { FleetSignInModal } from "./components/app/FleetSignInModal";
import { Toasts } from "./components/app/Toasts";
import { PromptHistoryModal } from "./components/chat/composer/PromptHistoryModal";
import { VoiceControls } from "./components/chat/composer/VoiceControls";
import { CompactionModal } from "./components/chat/controls/CompactionModal";
import { GoalModal } from "./components/chat/controls/GoalModal";
import { AddProjectModal } from "./components/fleet/workspaces/AddProjectModal";
import { DeleteWorkspaceDialog } from "./components/fleet/workspaces/DeleteWorkspaceDialog";
import { RemoveProjectDialog } from "./components/fleet/workspaces/RemoveProjectDialog";
import { AddWorkspaceModal } from "./components/fleet/workspaces/AddWorkspaceModal";
import { ProviderLoginModal } from "./components/models/ProviderLoginModal";
import { ModelPicker } from "./components/models/ModelPicker";
import { ThinkingLevelPicker } from "./components/models/ThinkingLevelPicker";
import { AskDialog } from "./components/requests/AskDialog";
import { ExtensionUi } from "./components/requests/ExtensionUi";
import { BtwPanel } from "./components/requests/BtwPanel";
import { DangerConfirmDialog } from "./components/requests/DangerConfirmDialog";
import { DownloadDialog } from "./components/requests/DownloadDialog";
import { AnnotationsPanel } from "./components/review/AnnotationsPanel";
import { GitPanel } from "./components/review/GitPanel";
import { PlanReviewPanel } from "./components/review/PlanReviewPanel";
import { TodoBoard } from "./components/review/TodoBoard";
import { SessionGraphModal } from "./components/sessions/SessionGraphModal";
import { BtwHistoryModal } from "./components/sessions/BtwHistoryModal";
import { ResumePicker } from "./components/sessions/ResumePicker";
import { SessionPicker } from "./components/sessions/SessionPicker";
import { McpManager } from "./components/settings/integrations/McpManager";
import { SkillsManager } from "./components/settings/integrations/SkillsManager";
import { SettingsModal } from "./components/settings/SettingsModal";
import { SubagentHub } from "./components/subagents/SubagentHub";
import { SessionStatsModal } from "./components/usage/SessionStatsModal";
import { UsageLimitsModal } from "./components/usage/UsageLimitsModal";
import { setState, state, type ModalName } from "./state";
import { resumePickerOpen } from "./store/resume";

/**
 * Every overlay App mounts: the active `state.modal`, plus the dialogs that
 * mount once and render nothing until their own store state asks for them
 * (agent ask/confirm/download requests, extension UI, /btw, resume, fleet
 * confirmations, toasts).
 */
export const ModalHost: Component = () => {
	const close = () => setState("modal", null);
	// One renderer per `state.modal` value. `satisfies Record<ModalName, …>`
	// makes a modal without a renderer a type error, and object keys are
	// unique, so a modal can never be mounted twice.
	const modals = {
		help: () => <ShortcutsModal onClose={close} />,
		model: () => <ModelPicker onClose={close} />,
		thinking: () => <ThinkingLevelPicker onClose={close} />,
		stats: () => <SessionStatsModal onClose={close} />,
		settings: () => <SettingsModal onClose={close} />,
		sessions: () => <SessionPicker onClose={close} />,
		branch: () => <SessionGraphModal onClose={close} />,
		history: () => <PromptHistoryModal onClose={close} />,
		subagents: () => <SubagentHub onClose={close} />,
		login: () => <ProviderLoginModal onClose={close} />,
		goal: () => <GoalModal onClose={close} />,
		usage: () => <UsageLimitsModal onClose={close} />,
		debug: () => <FleetDebugModal onClose={close} />,
		"add-project": () => <AddProjectModal onClose={close} />,
		workspace: () => <AddWorkspaceModal onClose={close} />,
		"sign-in": () => <FleetSignInModal onClose={close} />,
		mcp: () => <McpManager onClose={close} />,
		skills: () => <SkillsManager onClose={close} />,
		git: () => <GitPanel />,
		"plan-review": () => <PlanReviewPanel />,
		annotations: () => <AnnotationsPanel />,
		todos: () => <TodoBoard />,
		compaction: () => <CompactionModal onClose={close} />,
		"btw-history": () => <BtwHistoryModal onClose={close} />,
		voice: () => (
			<Show
				when={state.sessionScope}
				keyed
				fallback={<div class="msg-notice">Attach a session before using voice.</div>}
			>
				{(scope) => <VoiceControls scope={scope} />}
			</Show>
		),
	} satisfies Record<ModalName, () => JSX.Element>;
	return (
		<>
			<Show when={state.modal} keyed>
				{(name) => modals[name]()}
			</Show>
			<AskDialog />
			<BtwPanel />
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
