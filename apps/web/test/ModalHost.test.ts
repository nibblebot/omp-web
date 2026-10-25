import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as solid from "solid-js";
import * as store from "solid-js/store";
import * as stateModule from "../state";
import * as registryModule from "../features/registry";
import { FEATURE_IDS } from "../features/manifest";
import type * as HostModule from "../ModalHost";
import type * as ModalUiModule from "../components/ui/Modal";
import type * as ShortcutsModule from "../components/app/ShortcutsDialog";
import type * as SessionDetailsModule from "../components/fleet/session/SessionDetailsDialog";
import type * as WorktreeSessionsModule from "../components/fleet/sidebar/WorktreeSessionsDialog";
import type * as IntegrationsModule from "../components/settings/integrations/IntegrationsDialog";
import type * as RegistryModule from "../features/registry";
import type * as ModalsModule from "../store/modals";
import type * as StateModule from "../state";
import { installJsxShim, restoreJsxShim } from "./web.testkit";
import type { RosterEntry } from "#lib/wire/protocol";

// ---------------------------------------------------------------------------
// Harness: run the real ModalHost body without a DOM.
//
// bun resolves "solid-js" and "solid-js/store" to their SSR builds (effects
// never run, stores are plain non-reactive objects) and this suite has no DOM,
// so ModalHost cannot be rendered here. Mocking the client builds gives the
// component a live reactive scope — its roster effect reacts to real store
// writes — while a stub element factory stands in for `document`: `Show`/`For`
// are still called (so `state.modal` is dispatched for real) and every created
// component is recorded by identity instead of mounted (mounting a dialog
// would touch the DOM). Element types are the observable, so assertions
// compare component identities.
//
// The suite installs client runtime exports and a test-local reactive state
// before importing the host. This also works when sibling tests have already
// cached the normal SSR state. Original live exports are restored afterwards:
// Bun's mock.restore() alone does not undo mock.module replacements.
// ---------------------------------------------------------------------------
const CLIENT_SOLID: string = "solid-js/dist/solid.js";
const CLIENT_STORE: string = "solid-js/store/dist/store.js";

const originalSolid = { ...solid };
const originalStore = { ...store };
const originalState = { ...stateModule };
const originalRegistry = { ...registryModule };
let restoreSharedState: (() => Promise<void>) | undefined;

/** Element types the current host created, in order. */
const created: unknown[] = [];
/** Props of each entry in `created`, same index. */
const createdProps: Record<string, unknown>[] = [];
const flow = new Set<unknown>();
let ModalHost: typeof HostModule.ModalHost;
let ModalLayerContext: typeof ModalUiModule.ModalLayerContext;
let ShortcutsDialog: typeof ShortcutsModule.ShortcutsDialog;
let SessionDetailsDialog: typeof SessionDetailsModule.SessionDetailsDialog;
let WorktreeSessionsDialog: typeof WorktreeSessionsModule.WorktreeSessionsDialog;
let IntegrationsDialog: typeof IntegrationsModule.IntegrationsDialog;
let activateFeatures: typeof RegistryModule.activateFeatures;
let featureModal: typeof RegistryModule.featureModal;
let closeSessionDetails: typeof ModalsModule.closeSessionDetails;
let closeWorktreeSessions: typeof ModalsModule.closeWorktreeSessions;
let openSessionDetails: typeof ModalsModule.openSessionDetails;
let openWorktreeSessions: typeof ModalsModule.openWorktreeSessions;
let setState: typeof StateModule.setState;
let state: typeof StateModule.state;

beforeAll(async () => {
	const previousActiveFeatures = FEATURE_IDS.filter(originalRegistry.isFeatureEnabled);
	const previousToasts = originalState.state.toasts.map((toast) => ({ ...toast }));
	restoreSharedState = async () => {
		await originalRegistry.activateFeatures(previousActiveFeatures);
		originalState.setState("toasts", previousToasts);
	};
	const clientSolid = { ...(await import(CLIENT_SOLID)) };
	mock.module("solid-js", () => clientSolid);
	const clientStore = { ...(await import(CLIENT_STORE)) };
	mock.module("solid-js/store", () => clientStore);
	const [reactiveState, reactiveSetState] = store.createStore({
		...originalState.state,
		// Roster updates belong only to this suite, not the shared SSR singleton.
		sessionRoster: [...originalState.state.sessionRoster],
	});
	mock.module("../state", () => ({
		...originalState,
		state: reactiveState,
		setState: reactiveSetState,
	}));
	// A fresh real registry keeps this suite's feature loads out of sibling caches.
	// Static imports cannot exercise this isolated module-loading boundary.
	const registryPath: string = "../features/registry.ts?fresh=modal-host-isolation";
	const isolatedRegistry = { ...(await import(registryPath)) };
	mock.module("../features/registry", () => isolatedRegistry);
	flow.add(solid.Show);
	flow.add(solid.For);
	// Static imports cannot bind the host to the suite-scoped client runtime.
	({ ModalHost } = await import("../ModalHost"));
	({ ModalLayerContext } = await import("../components/ui/Modal"));
	({ ShortcutsDialog } = await import("../components/app/ShortcutsDialog"));
	({ SessionDetailsDialog } = await import("../components/fleet/session/SessionDetailsDialog"));
	({ WorktreeSessionsDialog } = await import("../components/fleet/sidebar/WorktreeSessionsDialog"));
	({ IntegrationsDialog } = await import("../components/settings/integrations/IntegrationsDialog"));
	({ activateFeatures, featureModal } = await import("../features/registry"));
	({ closeSessionDetails, closeWorktreeSessions, openSessionDetails, openWorktreeSessions } =
		await import("../store/modals"));
	({ setState, state } = await import("../state"));
});

afterAll(async () => {
	restoreJsxShim();
	mock.module("../features/registry", () => originalRegistry);
	mock.module("../state", () => originalState);
	mock.module("solid-js/store", () => originalStore);
	mock.module("solid-js", () => originalSolid);
	await restoreSharedState?.();
});

/** Minimal roster entry, same shape the fleet edge puts in a roster frame. */
function session(id: string): RosterEntry {
	return {
		workspaceId: id,
		name: id,
		cwd: `/repos/${id}`,
		project: id,
		status: "ready",
	};
}

let disposeHost: (() => void) | null = null;

/**
 * Mount ModalHost in a fresh reactive root and return the element types its JSX
 * created, in order. The previous host is disposed first so at most one roster
 * effect is live at a time.
 */
function renderHost(): unknown[] {
	disposeHost?.();
	created.length = 0;
	createdProps.length = 0;
	disposeHost = solid.createRoot((dispose) => {
		solid.createComponent(ModalHost, {});
		return dispose;
	});
	return [...created];
}

beforeEach(async () => {
	installJsxShim({
		onElement(type, props) {
			created.push(type);
			createdProps.push(props);
			if (typeof type === "function" && flow.has(type)) return undefined;
			return { value: { type, props } };
		},
	});
	closeSessionDetails();
	closeWorktreeSessions();
	setState("modal", null);
	setState("sessionRoster", []);
	await activateFeatures([]);
});

afterEach(() => {
	disposeHost?.();
	disposeHost = null;
});

describe("ModalHost", () => {
	test("renders the renderer registered for state.modal", () => {
		expect(renderHost()).not.toContain(ShortcutsDialog);
		setState("modal", "help");
		expect(renderHost()).toContain(ShortcutsDialog);
	});

	test("/help opens Commands and /hotkeys opens Shortcuts", () => {
		setState("modal", "help");
		renderHost();
		expect(createdProps[created.indexOf(ShortcutsDialog)]?.initialTab).toBe("commands");
		setState("modal", "hotkeys");
		renderHost();
		expect(createdProps[created.indexOf(ShortcutsDialog)]?.initialTab).toBe("shortcuts");
	});

	test("renders nothing for a modal owned by a feature that is off", () => {
		// The layer's context provider is structure, not a dialog.
		const dialogs = (types: unknown[]) => types.filter((t) => t !== ModalLayerContext.Provider);
		const withoutModal = dialogs(renderHost());
		// "plan-review" belongs to the plan feature, which is not active on this page.
		setState("modal", "plan-review");
		expect(dialogs(renderHost())).toEqual(withoutModal);
	});

	test("renders the feature's registered renderer once the feature is active", async () => {
		await activateFeatures(["plan"]);
		setState("modal", "plan-review");
		const registered = featureModal("plan-review");
		expect(registered).toBeDefined();
		expect(renderHost()).toContain(registered);
	});

	test("renders the Extensions dialog with no features active", () => {
		setState("modal", "integrations");
		expect(renderHost()).toContain(IntegrationsDialog);
	});

	test("renders nothing for the todos sheet with no features active", () => {
		const dialogs = (types: unknown[]) => types.filter((t) => t !== ModalLayerContext.Provider);
		const withoutModal = dialogs(renderHost());
		setState("modal", "todos");
		expect(dialogs(renderHost())).toEqual(withoutModal);
	});

	test("renders the session details dialog while its session is in the roster", () => {
		setState("sessionRoster", [session("d1")]);
		openSessionDetails("d1");
		expect(renderHost()).toContain(SessionDetailsDialog);
		expect(state.sessionDetailsId).toBe("d1");
	});

	test("clears the session details slot when its session leaves the roster", () => {
		setState("sessionRoster", [session("d1"), session("d2")]);
		openSessionDetails("d2");
		expect(renderHost()).toContain(SessionDetailsDialog);
		// An unrelated session leaving changes nothing.
		setState("sessionRoster", [session("d2")]);
		expect(state.sessionDetailsId).toBe("d2");
		// The session the slot names is gone: the open dialog closes itself and
		// the next mount renders nothing for the stale id.
		setState("sessionRoster", []);
		expect(state.sessionDetailsId).toBeNull();
		expect(renderHost()).not.toContain(SessionDetailsDialog);
	});

	test("a stale session details id is cleared instead of mounting the dialog", () => {
		openSessionDetails("d1");
		expect(renderHost()).not.toContain(SessionDetailsDialog);
		expect(state.sessionDetailsId).toBeNull();
	});

	test("renders the worktree session dialog while its session is in the roster", () => {
		setState("sessionRoster", [session("d1")]);
		openWorktreeSessions("d1");
		expect(renderHost()).toContain(WorktreeSessionsDialog);
		expect(state.modal).toBe("worktree-sessions");
		expect(state.worktreeSessionsId).toBe("d1");
	});

	test("closes the worktree session dialog when its session leaves the roster", () => {
		setState("sessionRoster", [session("d1"), session("d2")]);
		openWorktreeSessions("d2");
		renderHost();
		// An unrelated session leaving changes nothing.
		setState("sessionRoster", [session("d2")]);
		expect(state.modal).toBe("worktree-sessions");
		setState("sessionRoster", []);
		expect(state.modal).toBeNull();
		expect(state.worktreeSessionsId).toBeNull();
	});

	test("a stale worktree session id is cleared instead of mounting the dialog", () => {
		openWorktreeSessions("d1");
		expect(renderHost()).not.toContain(WorktreeSessionsDialog);
		expect(state.modal).toBeNull();
		expect(state.worktreeSessionsId).toBeNull();
	});

	describe("layers", () => {
		/** The layer handle ModalHost provided to the modal rendered for the open `state.modal`. */
		function openLayer(): {
			exiting: () => boolean;
			hold: () => void;
			release: () => void;
		} {
			const at = created.lastIndexOf(ModalLayerContext.Provider);
			return createdProps[at]?.value as ReturnType<typeof openLayer>;
		}

		test("a modal that does not hold its layer never enters an exit (the host unmounts it at once)", () => {
			setState("modal", "help");
			renderHost();
			const layer = openLayer();
			setState("modal", null);
			expect(layer.exiting()).toBe(false);
		});

		test("a modal that holds its layer (a side sheet) keeps it through the exit", () => {
			setState("modal", "help");
			renderHost();
			const layer = openLayer();
			layer.hold();
			setState("modal", null);
			expect(layer.exiting()).toBe(true);
		});
	});
});
