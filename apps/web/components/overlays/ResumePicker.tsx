import { For, Show, createSignal, onMount, type Component } from "solid-js";
import { Modal } from "../shared/Modal";
import { PickerRow } from "../shared/PickerRow";
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
	previewImport,
	resumeAmbiguous,
	resumeCandidates,
	resumeError,
	resumeLoading,
	resumeNotice,
	resumePinnedIds,
	resumeQuery,
	resumeUnavailable,
	searchResume,
	setForeignSource,
	stageUpload,
	togglePin,
	type ForeignSessionPreview,
	type ResumeCandidate,
} from "../../store/resume";
import { state } from "../../state";

/**
 * G20 resume picker (thin component; the store owns all state).
 *
 * Sections: search box, pinned-first resume list (pin toggles, provenance
 * badges), ambiguous-choice list, refusal/miss messages, foreign source
 * picker (Claude/Codex) + upload button + preview + size/type errors +
 * provenance note + confirm/cancel, deleted-workspace warning (surfaced via
 * the store's error text from lineageResume) + resume-onto-fresh-clone
 * confirm (delegated to the Analysis stored-history surface, which owns
 * api.resumeClone).
 *
 * WIRING NOTE: deliberately NOT registered in overlays/index.ts (contract).
 * Mount from App.tsx or a /resume command route; open via openResumePicker().
 *
 * Pin copy: rows say "resume-list pin" — a picker-ordering marker only. It
 * is not a credential/account pin (automatic OAuth session stickiness) and
 * it does not change what the model keeps in context.
 */

function formatTime(ms: number): string {
	if (!ms) return "unknown time";
	return new Date(ms).toLocaleString();
}

function provenanceNote(candidate: ResumeCandidate): string {
	return candidate.scope === "global" ? "other project" : "this project";
}

const ResumeRow: Component<{
	candidate: ResumeCandidate;
	onChoose: (candidate: ResumeCandidate) => void;
}> = (props) => {
	const candidate = () => props.candidate;
	return (
		<div class="resume-row">
			<PickerRow
				class="picker-row"
				onClick={() => props.onChoose(candidate())}
				title={`Resume ${candidate().id}`}
			>
				<span class="picker-label">{candidate().title || candidate().id.slice(0, 8)}</span>
				<span class="picker-detail">
					{candidate().messageCount} msgs · {formatTime(candidate().modifiedMs)} ·{" "}
					{provenanceNote(candidate())}
					{candidate().status ? ` · ${candidate().status}` : ""}
				</span>
			</PickerRow>
			<button
				type="button"
				class="resume-pin"
				aria-pressed={candidate().pinned}
				aria-label={`${candidate().pinned ? "Unpin" : "Pin"} resume-list pin for ${candidate().id.slice(0, 8)}`}
				title={
					candidate().pinned
						? "Remove resume-list pin (picker ordering only)"
						: "Add resume-list pin (picker ordering only — not a credential or context pin)"
				}
				onClick={() => togglePin(candidate().id)}
			>
				{candidate().pinned ? "★" : "☆"}
			</button>
		</div>
	);
};

const ForeignRow: Component<{
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
			<span class="picker-label">{preview().title || preview().id.slice(0, 12)}</span>
			<span class="picker-detail">
				{preview().sourceName} · {preview().messageCount} msgs · {formatTime(preview().modifiedMs)}
				{preview().staged ? " · staged upload" : ""}
			</span>
		</PickerRow>
	);
};

export const ResumePicker: Component<{
	daemonId?: string;
	workspaceId?: string;
	onClose: () => void;
}> = (props) => {
	const [query, setQuery] = createSignal(resumeQuery());
	const [targetArg, setTargetArg] = createSignal("");
	const [showImport, setShowImport] = createSignal(false);
	const [selectedDaemon, setSelectedDaemon] = createSignal(props.daemonId ?? "");
	const [foreignRoot, setForeignRoot] = createSignal("");
	const [fallbackCwd, setFallbackCwd] = createSignal("");
	const [cloneProfile, setCloneProfile] = createSignal("");
	let fileInput: HTMLInputElement | undefined;

	onMount(() => {
		void searchResume("");
		void listForeign(importSource());
	});

	const close = () => {
		closeResumePicker();
		props.onClose();
	};

	const choose = (candidate: ResumeCandidate) => {
		void chooseResumeTarget(candidate.id, selectedDaemon() || undefined).then((outcome) => {
			if (outcome.kind === "unique") close();
		});
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

	const ambiguous = () => resumeAmbiguous();
	const candidates = () => resumeCandidates();
	const pinnedCount = () => resumePinnedIds().length;

	return (
		<Modal title="Resume session" onClose={close}>
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
						class="resume-search"
						placeholder="Search sessions (ID, prefix, title, directory)…"
						aria-label="Search resumable sessions"
						value={query()}
						onInput={(e) => {
							setQuery(e.currentTarget.value);
							void searchResume(e.currentTarget.value);
						}}
					/>
				</div>

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

				<Show when={ambiguous() !== null}>
					<div class="resume-section-title">Multiple sessions match — choose one:</div>
					<div class="picker-list">
						<For each={ambiguous() ?? []}>
							{(candidate) => <ResumeRow candidate={candidate} onChoose={choose} />}
						</For>
					</div>
				</Show>

				<div class="resume-section-title">
					Resumable sessions{pinnedCount() > 0 ? ` (${pinnedCount()} resume-list pinned)` : ""}
				</div>
				<Show
					when={!resumeLoading()}
					fallback={<div class="tool-collapsed-note">loading sessions…</div>}
				>
					<Show
						when={candidates().length > 0}
						fallback={<div class="tool-collapsed-note">no resumable sessions</div>}
					>
						<div class="picker-list">
							<For each={candidates()}>
								{(candidate) => <ResumeRow candidate={candidate} onChoose={choose} />}
							</For>
						</div>
					</Show>
				</Show>
				<div class="resume-pin-legend">
					★ = resume-list pin (picker ordering only). Not a credential/account pin (automatic OAuth
					stickiness) and not a context pin (what the model keeps in context).
				</div>

				<div class="resume-section-title">
					<button
						type="button"
						class="resume-toggle"
						aria-expanded={showImport()}
						onClick={() => setShowImport(!showImport())}
					>
						{showImport() ? "▾" : "▸"} Import a Claude/Codex transcript
					</button>
				</div>
				<Show when={showImport()}>
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
									{(preview) => <ForeignRow preview={preview} onPreview={previewImport} />}
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
									{preview().messageCount} msgs · created {formatTime(preview().createdMs)} ·
									modified {formatTime(preview().modifiedMs)}
								</div>
								<div class="picker-detail">{preview().cwd || "(no recorded directory)"}</div>
								<Show when={preview().firstMessage}>
									{(first) => <div class="picker-detail">“{first().slice(0, 200)}”</div>}
								</Show>
								<div class="resume-provenance-note">
									Import creates a NEW native session and records {preview().sourceName} provenance
									(source ID, path, directory). The foreign original is never modified. Uploads are
									validated (JSON/JSONL, 64 MiB cap, no executables or symlinks) and staged only
									until import or cancel.
								</div>
								<div class="modal-actions">
									<button type="button" disabled={importLoading()} onClick={confirmImportSelection}>
										Confirm import
									</button>
									<button
										type="button"
										onClick={() => {
											cancelImport();
										}}
									>
										Cancel
									</button>
								</div>
							</div>
						)}
					</Show>
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
					<button type="button" onClick={close}>
						Close
					</button>
				</div>
			</div>
		</Modal>
	);
};
