import { createMemo, createSignal, Show, type Component } from "solid-js";
import { formatSessionHostCommand, type SessionEnrollment } from "#lib/wire/session-host-command";
import { state } from "../../../state";
import { enrollRemoteSession } from "../../../store/projects";
import { Modal } from "../../ui/Modal";

/** An enrolled remote session: the one-time command to run on the session host. */
export interface RemoteEnrollment {
	daemonId: string;
	cwd: string | undefined;
	enrollment: SessionEnrollment;
}

/** Add a remote session: enroll a name, then show the one-time command that the
 *  operator runs on the session host. The fleet never dials the host; the host
 *  dials out and its row turns ready. The token lives only in this component's
 *  signal, never in the store, URL, or storage. */
export const AddRemoteDialog: Component<{ onClose: () => void; initial?: RemoteEnrollment }> = (
	props,
) => {
	const [name, setName] = createSignal("");
	const [cwd, setCwd] = createSignal("");
	const [labels, setLabels] = createSignal("");
	const [busy, setBusy] = createSignal(false);
	const [error, setError] = createSignal<string | null>(null);
	const [copied, setCopied] = createSignal(false);
	const [enrolled, setEnrolled] = createSignal<RemoteEnrollment | null>(props.initial ?? null);

	const command = () => {
		const e = enrolled();
		return e === null ? "" : formatSessionHostCommand(e.enrollment, e.cwd);
	};

	const status = createMemo(() => {
		const e = enrolled();
		if (e === null) return null;
		return state.daemonRoster.find((d) => d.daemonId === e.daemonId)?.status ?? null;
	});

	const submit = async () => {
		if (busy() || name().trim() === "") return;
		setBusy(true);
		setError(null);
		try {
			const trimmedCwd = cwd().trim();
			const result = await enrollRemoteSession({
				name: name().trim(),
				cwd: trimmedCwd === "" ? undefined : trimmedCwd,
				labels: labels()
					.split(",")
					.map((l) => l.trim())
					.filter((l) => l !== ""),
			});
			setEnrolled({ ...result, cwd: trimmedCwd === "" ? undefined : trimmedCwd });
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	const copy = async () => {
		try {
			await navigator.clipboard.writeText(command());
			setCopied(true);
		} catch {
			setError("copy failed: select the command and copy it by hand");
		}
	};

	return (
		<Modal title="Add remote session" onClose={props.onClose}>
			<Show
				when={enrolled()}
				fallback={
					<div class="project-form">
						<label class="daemon-detail-label" for="remote-name">
							name
						</label>
						<input
							id="remote-name"
							class="picker-filter"
							placeholder="build-box"
							value={name()}
							onInput={(e) => setName(e.currentTarget.value)}
							spellcheck={false}
						/>
						<label class="daemon-detail-label" for="remote-cwd">
							project directory on the session host (optional)
						</label>
						<input
							id="remote-cwd"
							class="picker-filter"
							placeholder="/srv/app"
							value={cwd()}
							onInput={(e) => setCwd(e.currentTarget.value)}
							spellcheck={false}
						/>
						<label class="daemon-detail-label" for="remote-labels">
							labels
						</label>
						<input
							id="remote-labels"
							class="picker-filter"
							placeholder="tag=api, env=prod"
							value={labels()}
							onInput={(e) => setLabels(e.currentTarget.value)}
							spellcheck={false}
						/>
						<Show when={error()}>
							{(err) => <div class="msg-notice project-error">{err()}</div>}
						</Show>
						<div class="project-actions">
							<button
								type="button"
								class="project-btn"
								disabled={busy() || name().trim() === ""}
								onClick={() => void submit()}
							>
								{busy() ? "enrolling…" : "Create enrollment"}
							</button>
						</div>
					</div>
				}
			>
				{(e) => (
					<div class="project-form remote-enroll">
						<div class="msg-notice remote-enroll-warning">
							Shown once. The fleet keeps only a digest of this token, so close this dialog and it
							cannot be shown again. Run the command on the session host.
						</div>
						<pre class="remote-enroll-command" tabindex="0">
							{command()}
						</pre>
						<div class="project-actions">
							<button type="button" class="project-btn" onClick={() => void copy()}>
								{copied() ? "copied" : "Copy command"}
							</button>
						</div>
						<Show when={error()}>
							{(err) => <div class="msg-notice project-error">{err()}</div>}
						</Show>
						<div class="remote-enroll-status" aria-live="polite">
							{status() === "ready"
								? "connected: the session process on the host is ready"
								: status() === "error"
									? "the session process reported an error, check its log"
									: `waiting for the session process on the host to connect (${e().daemonId})`}
						</div>
					</div>
				)}
			</Show>
		</Modal>
	);
};
