import {
	ErrorBoundary,
	For,
	Show,
	createComputed,
	createEffect,
	createSignal,
	on,
	onMount,
	type Component,
	type JSX,
} from "solid-js";
import { FleetSignInDialog } from "./components/app/FleetSignInDialog";
import { Toasts } from "./components/app/Toasts";
import { DeleteWorkspaceDialog } from "./components/fleet/workspaces/DeleteWorkspaceDialog";
import { RemoveProjectDialog } from "./components/fleet/workspaces/RemoveProjectDialog";
import { ExtensionUi } from "./components/requests/ExtensionUi";
import { DangerConfirmDialog } from "./components/requests/DangerConfirmDialog";
import { DownloadDialog } from "./components/requests/DownloadDialog";
import { ImageLightbox } from "./components/ui/ImageLightbox";
import { createModalLayer, ModalLayerContext, type ModalLayer } from "./components/ui/Modal";
import { lazyComponent } from "./components/ui/lazy";
import { featureModal, featureOverlays } from "./features/registry";
import { pushToast } from "./store/toasts";
import {
	closeSessionDetails,
	closeLightbox,
	closeWorktreeSessions,
	setState,
	state,
	type ModalName,
} from "./state";

/** Dialogs and sheets load on first open, not with the entry chunk. */
const ShortcutsDialog = lazyComponent(() =>
	import("./components/app/ShortcutsDialog").then((m) => m.ShortcutsDialog),
);
const CommandPalettePicker = lazyComponent(() =>
	import("./components/app/CommandPalettePicker").then((m) => m.CommandPalettePicker),
);
const AppearanceSheet = lazyComponent(() =>
	import("./components/app/AppearanceSheet").then((m) => m.AppearanceSheet),
);
const CompactionDialog = lazyComponent(() =>
	import("./components/chat/controls/CompactionDialog").then((m) => m.CompactionDialog),
);
const GoalDialog = lazyComponent(() =>
	import("./components/chat/controls/GoalDialog").then((m) => m.GoalDialog),
);
const AddProjectDialog = lazyComponent(() =>
	import("./components/fleet/workspaces/AddProjectDialog").then((m) => m.AddProjectDialog),
);
const SessionDetailsDialog = lazyComponent(() =>
	import("./components/fleet/session/SessionDetailsDialog").then((m) => m.SessionDetailsDialog),
);
const WorktreeSessionsDialog = lazyComponent(() =>
	import("./components/fleet/sidebar/WorktreeSessionsDialog").then((m) => m.WorktreeSessionsDialog),
);
const ModelDialog = lazyComponent(() =>
	import("./components/models/ModelDialog").then((m) => m.ModelDialog),
);
const BtwSheet = lazyComponent(() =>
	import("./components/requests/BtwSheet").then((m) => m.BtwSheet),
);
const SessionPicker = lazyComponent(() =>
	import("./components/sessions/SessionPicker").then((m) => m.SessionPicker),
);
const SettingsSheet = lazyComponent(() =>
	import("./components/settings/SettingsSheet").then((m) => m.SettingsSheet),
);
const IntegrationsDialog = lazyComponent(() =>
	import("./components/settings/integrations/IntegrationsDialog").then((m) => m.IntegrationsDialog),
);
const ShareSheet = lazyComponent(() =>
	import("./components/collab/ShareSheet").then((m) => m.ShareSheet),
);
const SessionStatsDialog = lazyComponent(() =>
	import("./components/usage/SessionStatsDialog").then((m) => m.SessionStatsDialog),
);
const AdvisorSheet = lazyComponent(() =>
	import("./components/subagents/AdvisorSheet").then((m) => m.AdvisorSheet),
);
const UsageLimitsDialog = lazyComponent(() =>
	import("./components/usage/UsageLimitsDialog").then((m) => m.UsageLimitsDialog),
);

/**
 * Fetch the chunks of the dialogs behind the global shortcuts (Ctrl+K, Ctrl+,)
 * so their first open does not wait on the network. index.tsx runs this once
 * the page is idle; failures are ignored, the open retries the load.
 */
export function preloadShortcutModals(): void {
	for (const modal of [CommandPalettePicker, SettingsSheet]) modal.preload().catch(() => undefined);
}

/** What a modal shows when its module fails to load (or render): a toast, and the modal closes so a retry can reopen it. */
const ModalFailure: Component<{ error: unknown; onClose: () => void }> = (props) => {
	onMount(() => {
		pushToast(
			`That dialog could not open: ${props.error instanceof Error ? props.error.message : String(props.error)}`,
		);
		props.onClose();
	});
	return null;
};

/**
 * Every overlay App mounts: the active `state.modal`, plus the dialogs that
 * mount once and render nothing until their own store state asks for them
 * (agent ask/confirm/download requests, extension UI, resume, fleet
 * confirmations, session details, the image lightbox, toasts). Overlays owned
 * by an enabled feature come from the feature registry.
 */
export const ModalHost: Component = () => {
	const close = () => setState("modal", null);
	// Roster-gated slot: the details dialog renders only while its session is in
	// the roster, and a session that leaves the fleet clears the slot (mirrors
	// RemoveProjectDialog's project lookup).
	const sessionDetails = () => {
		const id = state.sessionDetailsId;
		return id === null ? undefined : state.sessionRoster.find((d) => d.workspaceId === id);
	};
	createEffect(() => {
		const id = state.sessionDetailsId;
		if (id !== null && !state.sessionRoster.some((d) => d.workspaceId === id))
			closeSessionDetails();
	});
	// Same roster gate for the worktree session list dialog: it renders only
	// while its session is in the roster, and a session that leaves closes it.
	const worktreeSessionsEntry = () => {
		const id = state.worktreeSessionsId;
		return id === null ? undefined : state.sessionRoster.find((d) => d.workspaceId === id);
	};
	createEffect(() => {
		if (state.modal === "worktree-sessions" && worktreeSessionsEntry() === undefined)
			closeWorktreeSessions();
	});
	// Renderer for a modal owned by an optional feature. Renders nothing when the
	// feature is disabled on this page, so a stale `state.modal` cannot mount feature UI.
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
		model: () => <ModelDialog onClose={close} />,
		palette: () => <CommandPalettePicker onClose={close} />,
		stats: () => <SessionStatsDialog onClose={close} />,
		settings: () => <SettingsSheet onClose={close} />,
		appearance: () => <AppearanceSheet onClose={close} />,
		sessions: () => <SessionPicker onClose={close} />,
		advisor: () => <AdvisorSheet onClose={close} />,
		login: () => featureModalHost("login"),
		goal: () => <GoalDialog onClose={close} />,
		usage: () => <UsageLimitsDialog onClose={close} />,
		debug: () => featureModalHost("debug"),
		"add-project": () => <AddProjectDialog onClose={close} />,
		"sign-in": () => <FleetSignInDialog onClose={close} />,
		integrations: () => <IntegrationsDialog onClose={close} />,
		"plan-review": () => featureModalHost("plan-review"),
		annotations: () => featureModalHost("annotations"),
		todos: () => featureModalHost("todos"),
		compaction: () => <CompactionDialog onClose={close} />,
		share: () => <ShareSheet onClose={close} />,
		btw: () => <BtwSheet onClose={close} />,
		"worktree-sessions": () => (
			<Show when={worktreeSessionsEntry()}>
				{(session) => (
					<WorktreeSessionsDialog session={session()} onClose={closeWorktreeSessions} />
				)}
			</Show>
		),
	} satisfies Record<ModalName, () => JSX.Element>;
	// One layer per open `state.modal`. A side sheet keeps its layer mounted
	// through its slide-out (Modal calls `hold()`), so a sheet that is closing
	// and the dialog replacing it (Settings -> provider login) coexist briefly;
	// every other modal's layer unmounts the moment its modal closes.
	interface Layer extends ModalLayer {
		readonly name: ModalName;
		close: () => void;
	}
	const [layers, setLayers] = createSignal<Layer[]>([]);
	const openLayer = (name: ModalName): Layer => {
		const layer: Layer = {
			name,
			...createModalLayer(() => setLayers((all) => all.filter((l) => l !== layer))),
		};
		setLayers((all) => [...all, layer]);
		return layer;
	};
	let active: Layer | undefined;
	createComputed(
		on(
			() => state.modal,
			(name) => {
				active?.close();
				active = name === null ? undefined : openLayer(name);
			},
		),
	);
	return (
		<>
			<For each={layers()}>
				{(layer) => (
					<ModalLayerContext.Provider value={layer}>
						<ErrorBoundary
							fallback={(error) => (
								<ModalFailure
									error={error}
									onClose={() => {
										if (state.modal === layer.name) close();
									}}
								/>
							)}
						>
							{modals[layer.name]()}
						</ErrorBoundary>
					</ModalLayerContext.Provider>
				)}
			</For>
			<Show when={state.lightboxImage} keyed>
				{(img) => <ImageLightbox image={img} onClose={closeLightbox} />}
			</Show>
			<Show when={sessionDetails()}>
				{(session) => (
					<ErrorBoundary
						fallback={(error) => <ModalFailure error={error} onClose={closeSessionDetails} />}
					>
						<SessionDetailsDialog session={session()} onClose={closeSessionDetails} />
					</ErrorBoundary>
				)}
			</Show>
			<For each={featureOverlays()}>{(Overlay) => <Overlay />}</For>
			<ExtensionUi placement="modal" />
			<DownloadDialog />
			<DangerConfirmDialog />
			<DeleteWorkspaceDialog />
			<RemoveProjectDialog />
			<Toasts />
		</>
	);
};
