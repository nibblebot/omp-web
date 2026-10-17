import { createSignal, onMount, Show, type Component } from "solid-js";
import type { OmpSetupStatus } from "#lib/wire/protocol";
import { setState } from "../../../state";
import { fetchOmpSetup } from "../../../store/projects";
import { ompSetupSummary } from "../../../fleet-ui/first-run";
import { PlusIcon } from "../../ui/icons";

/** Phase 4 first-run empty state: replaces the one-line hint while the fleet
 *  has no config file, no registered projects, and no session processes. Three
 *  steps: add a project, sign in to a provider (live omp and auth status from
 *  GET /ctl/omp-setup), and start a session. Read-only: the browser never
 *  writes fleet config; the data-home choice stays with the TTY first-run offer. */
export const FirstRunPanel: Component = () => {
	const [setup, setSetup] = createSignal<OmpSetupStatus | null>(null);
	const [checkError, setCheckError] = createSignal<string | null>(null);
	const [checking, setChecking] = createSignal(false);

	const check = () => {
		setChecking(true);
		setCheckError(null);
		fetchOmpSetup()
			.then(setSetup)
			.catch((err) => setCheckError(err instanceof Error ? err.message : String(err)))
			.finally(() => setChecking(false));
	};

	onMount(check);

	return (
		<div class="firstrun">
			<div class="firstrun-title">Welcome to omp-web</div>
			<ol class="firstrun-steps">
				<li>
					<button
						type="button"
						class="firstrun-cta"
						onClick={() => setState("modal", "add-project")}
					>
						<PlusIcon /> Add your first project
					</button>
				</li>
				<li>
					<div>Sign in to a provider</div>
					<Show
						when={setup()}
						fallback={<div class="firstrun-status">{checking() ? "checking omp…" : ""}</div>}
					>
						{(s) => <div class="firstrun-status">{ompSetupSummary(s())}</div>}
					</Show>
					<Show when={checkError()}>
						{(msg) => <div class="msg-notice firstrun-status">{`omp check failed: ${msg()}`}</div>}
					</Show>
					<div class="firstrun-actions">
						<button type="button" class="daemon-row-btn" onClick={() => setState("modal", "login")}>
							Sign in to a provider
						</button>
						<button type="button" class="daemon-row-btn" disabled={checking()} onClick={check}>
							re-check
						</button>
					</div>
				</li>
				<li>
					<div>Start a session</div>
					<div class="firstrun-status">
						Sessions appear here once a project exists. Each project row has Start session.
					</div>
				</li>
			</ol>
			<div class="firstrun-status">
				Prefer the terminal? Run omp-web; its first-run offer sets the data home.
			</div>
		</div>
	);
};
