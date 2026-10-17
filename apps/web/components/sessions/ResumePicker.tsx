import { For, Show, createSignal, onMount, type Component } from "solid-js";
import { Modal } from "../ui/Modal";
import { PickerRow } from "../ui/PickerRow";
import { displayTitle } from "../ui/title-icons";
import {
	reportImportError,
	resumeCloneRequest,
	setResumeCloneRequest,
	resumeStoredClone,
	cancelImport,
	chooseResumeTarget,
	closeResumePicker,
	confirmImport,
	importCandidates,
	importError,
	importLoading,
	importPreview,
	importSource,
	listForeign,
	openResumePicker,
	previewImport,
	resumeError,
	resumeLoading,
	resumeNotice,
	resumeUnavailable,
	setForeignSource,
	stageUpload,
	type ForeignSessionPreview,
} from "../../store/resume";
import { state } from "../../state";

/**
 * Resume by ID or import (the second dialog behind the session list). The
 * list itself is SessionPicker; this dialog resolves an explicit id, prefix,
 * or authorized path, imports a Claude/Codex transcript, and confirms a
 * resume onto a fresh clone when the original workspace is gone. The store
 * owns all state.
 *
 * Opened from the list via openResumeImport(); "Back to sessions" returns to
 * the list. Ambiguous resolves hand off to the list (the store does that).
 *
 * Pin copy in the list says "resume-list pin": a picker-ordering marker only.
 * It is not a credential/account pin and does not change model context.
 */

function formatTime(ms: number): string {
	if (!ms) return "unknown time";
	return new Date(ms).toLocaleString();
}

const ForeignSessionRow: Component<{
	preview: ForeignSessionPreview;
	onPreview: (id: string) => void;
}> = (props) => {
	const preview = () => props.preview;
	return (
		<PickerRow
			class="picker-row"
			onClick={() => props.onPreview(preview().id)}
			title={`Preview ${preview().sourceName} session ${preview().id}`}
		>
			<span class="picker-label">{displayTitle(preview().title) || preview().id.slice(0, 12)}</span>
			<span class="picker-detail">
				{preview().sourceName} · {preview().messageCount} msgs · {formatTime(preview().modifiedMs)}
				{preview().staged ? " · staged upload" : ""}
			</span>
		</PickerRow>
	);
};

export const ResumePicker: Component<{ onClose: () => void }> = (props) => {
	const [targetArg, setTargetArg] = createSignal("");
	const [selectedDaemon, setSelectedDaemon] = createSignal("");
	const [foreignRoot, setForeignRoot] = createSignal("");
	const [fallbackCwd, setFallbackCwd] = createSignal("");
	const [cloneProfile, setCloneProfile] = createSignal("");
	let fileInput: HTMLInputElement | undefined;

	onMount(() => {
		void listForeign(importSource());
	});

	const close = () => {
		closeResumePicker();
		props.onClose();
	};

	const backToSessions = () => {
		closeResumePicker();
		openResumePicker();
	};

	const resolveTarget = () => {
		void chooseResumeTarget(targetArg(), selectedDaemon() || undefined).then((outcome) => {
			if (outcome.kind === "unique") close();
		});
	};

	const confirmImportSelection = () => {
		const preview = importPreview();
		if (!preview) return;
		void confirmImport(preview.id, fallbackCwd() || undefined).then((imported) => {
			if (imported !== null) close();
		});
	};

	const onFileSelected = (event: Event) => {
		const input = event.target as HTMLInputElement;
		const file = input.files?.[0];
		input.value = "";
		if (!file) return;
		if (file.size > 64 * 1024 * 1024) {
			reportImportError("Uploaded file exceeds the 64 MiB import cap.");
			return;
		}
		void file
			.arrayBuffer()
			.then((buffer) => stageUpload(importSource(), file.name, new Uint8Array(buffer)))
			.catch((error) =>
				reportImportError(
					error instanceof Error ? error.message : "Could not read the selected file.",
				),
			);
	};

	return (
		<Modal title="Resume by ID or import" onClose={close}>
			<div class="resume-picker">
				<Show when={resumeUnavailable()}>
					{(message) => <div class="msg-notice">{message()}</div>}
				</Show>
				<Show when={resumeNotice()}>{(message) => <div class="msg-notice">{message()}</div>}</Show>
				<Show when={resumeError()}>{(message) => <div class="msg-notice">{message()}</div>}</Show>

				<label class="field-row">
					Profile / workspace / directory
					<select
						aria-label="Owning profile workspace and directory"
						value={selectedDaemon()}
						onChange={(event) => setSelectedDaemon(event.currentTarget.value)}
					>
						<option value="">Resolve in attached workspace</option>
						<For each={state.daemonRoster}>
							{(entry) => (
								<option value={entry.daemonId}>
									{entry.providerProfileId || "local"} · {entry.name} · {entry.cwd} ({entry.status})
								</option>
							)}
						</For>
					</select>
				</label>

				<div class="field-row">
					<input
						type="text"
						class="resume-target"
						placeholder="Resume by ID, prefix, or authorized path…"
						aria-label="Resume target"
						value={targetArg()}
						onInput={(e) => setTargetArg(e.currentTarget.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") resolveTarget();
						}}
					/>
					<button type="button" class="resume-resolve" onClick={resolveTarget}>
						Resume
					</button>
				</div>

				<div class="resume-section-title">Import a Claude or Codex transcript</div>
				<div class="field-row" role="radiogroup" aria-label="Foreign session source">
					<button
						type="button"
						aria-pressed={importSource() === "claude"}
						onClick={() => setForeignSource("claude")}
					>
						Claude
					</button>
					<button
						type="button"
						aria-pressed={importSource() === "codex"}
						onClick={() => setForeignSource("codex")}
					>
						Codex
					</button>
					<button type="button" onClick={() => listForeign(importSource())}>
						Refresh
					</button>
					<button type="button" onClick={() => fileInput?.click()}>
						Upload file…
					</button>
					<input
						ref={(el) => (fileInput = el)}
						type="file"
						accept=".jsonl,.json,application/json"
						class="resume-upload-hidden"
						aria-label="Upload a Claude or Codex transcript (.jsonl or .json)"
						onChange={onFileSelected}
					/>
				</div>
				<label class="field-row">
					Authorized source root (optional)
					<input
						value={foreignRoot()}
						onInput={(event) => setForeignRoot(event.currentTarget.value)}
						placeholder="Configured fleet-host source directory"
					/>
					<button
						type="button"
						onClick={() => listForeign(importSource(), foreignRoot() || undefined)}
					>
						List authorized root
					</button>
				</label>
				<label class="field-row">
					Fallback directory when original no longer exists
					<input
						value={fallbackCwd()}
						onInput={(event) => setFallbackCwd(event.currentTarget.value)}
						placeholder="Attached workspace directory"
					/>
				</label>
				<Show when={importError()}>{(message) => <div class="msg-notice">{message()}</div>}</Show>
				<Show
					when={!importLoading()}
					fallback={<div class="tool-collapsed-note">loading foreign sessions…</div>}
				>
					<Show
						when={importCandidates().length > 0}
						fallback={<div class="tool-collapsed-note">no foreign sessions found</div>}
					>
						<div class="picker-list">
							<For each={importCandidates()}>
								{(preview) => <ForeignSessionRow preview={preview} onPreview={previewImport} />}
							</For>
						</div>
					</Show>
				</Show>
				<Show when={importPreview()}>
					{(preview) => (
						<div class="resume-import-preview">
							<div class="resume-section-title">Import preview</div>
							<div>
								{preview().title || preview().id} ({preview().sourceName})
							</div>
							<div class="picker-detail">
								{preview().messageCount} msgs · created {formatTime(preview().createdMs)} · modified{" "}
								{formatTime(preview().modifiedMs)}
							</div>
							<div class="picker-detail">{preview().cwd || "(no recorded directory)"}</div>
							<Show when={preview().firstMessage}>
								{(first) => <div class="picker-detail">“{first().slice(0, 200)}”</div>}
							</Show>
							<div class="resume-provenance-note">
								Import creates a NEW native session and records {preview().sourceName} provenance
								(source ID, path, directory). The foreign original is never modified. Uploads are
								validated (JSON/JSONL, 64 MiB cap, no executables or symlinks) and staged only until
								import or cancel.
							</div>
							<div class="modal-actions">
								<button type="button" disabled={importLoading()} onClick={confirmImportSelection}>
									Confirm import
								</button>
								<button type="button" onClick={() => cancelImport()}>
									Cancel
								</button>
							</div>
						</div>
					)}
				</Show>

				<Show when={resumeCloneRequest()}>
					{(request) => (
						<div class="resume-deleted-warning">
							<p>{request().warning}</p>
							<label>
								Provider profile (optional)
								<input
									value={cloneProfile()}
									onInput={(event) => setCloneProfile(event.currentTarget.value)}
								/>
							</label>
							<button
								type="button"
								disabled={resumeLoading()}
								onClick={() => {
									const target = request();
									void resumeStoredClone(
										target.workspaceId,
										target.sessionId,
										target.resumeClonePath,
										cloneProfile() || undefined,
									).then((result) => {
										if (result) close();
									});
								}}
							>
								Confirm resume onto fresh clone
							</button>
							<button type="button" onClick={() => setResumeCloneRequest(null)}>
								Cancel
							</button>
						</div>
					)}
				</Show>

				<div class="modal-actions">
					<button type="button" onClick={backToSessions}>
						Back to sessions
					</button>
					<button type="button" onClick={close}>
						Close
					</button>
				</div>
			</div>
		</Modal>
	);
};
