import { For, Match, Show, Switch, createSignal, type Component } from "solid-js";
import {
	closeDownload,
	confirmDownload,
	downloadProgress,
	openDownloadConsent,
	type DownloadConsent,
	type DownloadProgress,
	type WebDownloadKind,
} from "../../store/downloads";
import { Modal } from "../shared/Modal";

// G17 download consent + progress dialog (thin Solid component, transient
// presentation only). The store owns the manifest/consent/progress state;
// this file renders the kind picker, inclusion checkboxes (advisor/BTW) with
// the manifest preview, the plaintext/credential warning, consent
// confirm/cancel, and progress/error/cap display with safe filenames shown.
// No overlays/index.ts registration: mount DownloadDialog once from App
// alongside AskDialog/BtwPanel; it renders nothing while no download is
// in flight. Browser filenames shown here are display names, never server
// paths used as identity.

const PLAINTEXT_NOTE =
	"Downloads contain full prompts, tool calls, and tool output and may include secrets. " +
	"Review before sharing. No redaction is applied.";

function fileSizeLabel(bytes?: number): string {
	if (bytes === undefined) return "";
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Narrow the union progress to one phase for the keyed Show children. */
function asPhase<P extends DownloadProgress["phase"]>(
	state: DownloadProgress,
	phase: P,
): Extract<DownloadProgress, { phase: P }> | null {
	if (state.phase !== phase) return null;
	return state as Extract<DownloadProgress, { phase: P }>;
}

const ConsentBody: Component<{ consent: DownloadConsent }> = (props) => {
	const [advisor, setAdvisor] = createSignal(props.consent.includeAdvisor);
	const [btw, setBtw] = createSignal(props.consent.includeBtw);
	return (
		<div class="download-dialog">
			<p class="download-warning">{PLAINTEXT_NOTE}</p>
			<Show when={props.consent.warnings.length > 0}>
				<ul class="download-warnings">
					<For each={props.consent.warnings}>{(w) => <li>{w}</li>}</For>
				</ul>
			</Show>
			<div class="download-inclusions">
				<label>
					<input
						type="checkbox"
						checked={advisor()}
						onChange={(e) => setAdvisor(e.currentTarget.checked)}
					/>
					Include advisor recorders
				</label>
				<label>
					<input
						type="checkbox"
						checked={btw()}
						onChange={(e) => setBtw(e.currentTarget.checked)}
					/>
					Include BTW side sessions
				</label>
			</div>
			<Show
				when={props.consent.inclusions.length > 0}
				fallback={<p class="download-empty">Manifest lists no files yet for this selection.</p>}
			>
				<ul class="download-files">
					<For each={props.consent.inclusions.slice(0, 50)}>{(name) => <li>{name}</li>}</For>
				</ul>
				<Show when={props.consent.inclusions.length > 50}>
					<p class="download-more">+ {props.consent.inclusions.length - 50} more files</p>
				</Show>
			</Show>
			<p class="download-provenance">
				Session {props.consent.provenance.sessionId}
				<Show when={props.consent.workerCount > 0}> · {props.consent.workerCount} workers</Show>
			</p>
			<div class="ask-actions">
				<button type="button" onClick={closeDownload}>
					Cancel
				</button>
				<button
					type="button"
					class="danger-confirm-btn"
					onClick={() =>
						confirmDownload({ ...props.consent, includeAdvisor: advisor(), includeBtw: btw() })
					}
				>
					Download {props.consent.kind}
				</button>
			</div>
		</div>
	);
};

const KIND_OPTIONS: Array<{ kind: WebDownloadKind; label: string }> = [
	{ kind: "html", label: "HTML transcript" },
	{ kind: "html-themed", label: "HTML (themed)" },
	{ kind: "text", label: "Plain text" },
	{ kind: "request", label: "LLM request JSON" },
	{ kind: "archive", label: "Main + worker archive" },
];

/** Entry view: kind picker that starts the manifest -> consent flow. Render when no download is active. */
export const DownloadKindPicker: Component = () => (
	<div class="download-kind-picker">
		<For each={KIND_OPTIONS}>
			{(opt) => (
				<button type="button" onClick={() => void openDownloadConsent(opt.kind)}>
					{opt.label}
				</button>
			)}
		</For>
	</div>
);

export const DownloadDialog: Component = () => {
	const current = () => downloadProgress();
	return (
		<Show when={current()}>
			{(state) => (
				<Modal title="Download session" onClose={closeDownload}>
					<Switch>
						<Match when={state().phase === "manifest"}>
							<p class="download-status">Reading the download manifest…</p>
						</Match>
						<Match when={asPhase(state(), "consent")}>
							{(consent) => <ConsentBody consent={consent().consent} />}
						</Match>
						<Match when={state().phase === "producing"}>
							<p class="download-status">Producing the export on the daemon…</p>
						</Match>
						<Match when={asPhase(state(), "fetching")}>
							{(fetching) => (
								<p class="download-status">
									Downloading… {fileSizeLabel(fetching().receivedBytes)}
								</p>
							)}
						</Match>
						<Match when={asPhase(state(), "done")}>
							{(done) => (
								<div class="download-dialog">
									<p class="download-status">
										Saved {done().filename} ({fileSizeLabel(done().bytes)}).
									</p>
									<div class="ask-actions">
										<button type="button" onClick={closeDownload}>
											Close
										</button>
									</div>
								</div>
							)}
						</Match>
						<Match when={asPhase(state(), "error")}>
							{(failed) => (
								<div class="download-dialog">
									<p class="msg-notice">
										Download failed ({failed().code}): {failed().message}
									</p>
									<div class="ask-actions">
										<button type="button" onClick={closeDownload}>
											Close
										</button>
									</div>
								</div>
							)}
						</Match>
					</Switch>
				</Modal>
			)}
		</Show>
	);
};
