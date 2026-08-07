import { createEffect, createSignal, For, type Component } from "solid-js";
import { currentToken, fuzzyRank, type AcToken } from "../autocomplete";
import { dispatchInput, LOCAL_COMMANDS, type InputMode } from "../commands";
import { PromptHistory } from "../history";
import type { ImageArg } from "../protocol";
import { call, dequeueLastQueued, listFiles, promptInsert, setPromptInsert, setState, state } from "../state";
import { Autocomplete, type AcItem } from "./Autocomplete";

const history = new PromptHistory();

const LOCAL_DETAILS: Record<string, string> = {
	new: "Start a new session",
	clear: "Start a new session",
	resume: "Resume a previous session",
	tree: "Branch from an earlier message",
	branch: "Branch from an earlier message",
	export: "Export session as HTML",
	retry: "Retry the last failed turn",
	fork: "Fork this session's history",
	fresh: "Reset provider state, keep transcript",
	handoff: "Hand off to a new session with a summary document",
	drop: "Discard this session and start fresh",
	dump: "Download transcript and LLM request dump",
	rename: "Rename this session (bare: agent auto-titles)",
	compact: "Compact session context",
	queue: "Queue a follow-up message",
	help: "Keyboard shortcuts",
	hotkeys: "Keyboard shortcuts",
	exit: "Close this tab",
	quit: "Close this tab",
};

export const PromptBox: Component = () => {
	const [message, setMessage] = createSignal("");
	const [images, setImages] = createSignal<ImageArg[]>([]);
	const [token, setToken] = createSignal<AcToken | null>(null);
	const [dismissed, setDismissed] = createSignal(false);
	const [selected, setSelected] = createSignal(0);
	const [files, setFiles] = createSignal<string[]>([]);
	let textarea!: HTMLTextAreaElement;
	let debounceTimer: number | undefined;
	// Double-Esc on an empty textarea opens the branch picker (TUI parity).
	let lastEsc = 0;

	const autoGrow = () => {
		textarea.style.height = "auto";
		textarea.style.height = `${textarea.scrollHeight}px`;
	};

	const refreshToken = () => {
		if (dismissed()) return;
		setToken(currentToken(message(), textarea.selectionStart ?? message().length));
	};

	// @-file completions: debounced server-side walk, latest-wins.
	createEffect(() => {
		const t = token();
		if (t?.mode !== "file") return;
		window.clearTimeout(debounceTimer);
		debounceTimer = window.setTimeout(() => {
			listFiles(t.query)
				.then(setFiles)
				.catch(() => setFiles([]));
		}, 150);
	});

	// QueueBar dequeue / HistorySearch picks land here.
	createEffect(() => {
		const insert = promptInsert();
		if (!insert) return;
		setPromptInsert(null);
		if (insert.text) setMessage(prev => (prev.trim() ? `${prev}\n${insert.text}` : insert.text));
		if (insert.images?.length) setImages(prev => [...prev, ...insert.images!]);
		requestAnimationFrame(() => {
			textarea.focus();
			autoGrow();
		});
	});

	const items = (): AcItem[] => {
		const t = token();
		if (!t) return [];
		if (t.mode === "file") {
			return files().map(f => ({
				label: `@${f}`,
				apply: f.includes(" ") ? `@"${f}" ` : `@${f} `,
			}));
		}
		const local = Object.keys(LOCAL_COMMANDS).map(name => ({ name, detail: LOCAL_DETAILS[name] ?? "web-local" }));
		const remote = state.availableCommands
			.filter(c => !LOCAL_COMMANDS[c.name])
			.map(c => ({ name: c.name, detail: c.description ?? c.input?.hint ?? "" }));
		return [...local, ...remote]
			.map(c => ({ c, rank: fuzzyRank(t.query, c.name) }))
			.filter((x): x is { c: { name: string; detail: string }; rank: number } => x.rank !== null)
			.sort((a, b) => a.rank - b.rank)
			.map(x => ({ label: `/${x.c.name}`, detail: x.c.detail, apply: `/${x.c.name} ` }));
	};

	const open = () => token() !== null && items().length > 0;

	const apply = (item: AcItem) => {
		const t = token();
		if (!t) return;
		setMessage(message().slice(0, t.start) + item.apply + message().slice(t.end));
		setToken(null);
		requestAnimationFrame(() => {
			textarea.focus();
			const pos = t.start + item.apply.length;
			textarea.setSelectionRange(pos, pos);
			autoGrow();
		});
	};

	const submit = (mode: InputMode) => {
		const text = message().trim();
		const imgs = images();
		if (!text && imgs.length === 0) return;
		dispatchInput(message().trim(), imgs, mode);
		if (text) history.push(text);
		setMessage("");
		setImages([]);
		setToken(null);
		history.reset();
		requestAnimationFrame(autoGrow);
	};

	const onPaste = (e: ClipboardEvent) => {
		const items = [...(e.clipboardData?.items ?? [])].filter(it => it.type.startsWith("image/"));
		if (items.length === 0) return; // non-image paste: default behavior
		e.preventDefault();
		for (const item of items) {
			const file = item.getAsFile();
			if (!file) continue;
			const { promise, resolve } = Promise.withResolvers<string>();
			const reader = new FileReader();
			reader.onload = () => resolve(String(reader.result));
			reader.readAsDataURL(file);
			void promise.then(dataUrl => {
				const data = dataUrl.slice(dataUrl.indexOf(",") + 1);
				setImages(prev => [...prev, { type: "image", data, mimeType: item.type }]);
			});
		}
	};

	const onKeyDown = (e: KeyboardEvent) => {
		// Alt+↑ pops the last queued message back into the textarea.
		if (e.key === "ArrowUp" && e.altKey) {
			e.preventDefault();
			dequeueLastQueued();
			return;
		}
		// Autocomplete owns navigation while the popup is open.
		if (open()) {
			const list = items();
			if (e.key === "ArrowDown") {
				e.preventDefault();
				setSelected(i => (i + 1) % list.length);
				return;
			}
			if (e.key === "ArrowUp") {
				e.preventDefault();
				setSelected(i => (i - 1 + list.length) % list.length);
				return;
			}
			if (e.key === "Tab") {
				e.preventDefault();
				apply(list[selected()] ?? list[0]);
				return;
			}
			if (e.key === "Escape") {
				e.preventDefault();
				lastEsc = 0;
				setDismissed(true);
				setToken(null);
				return;
			}
			if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
				const sel = list[selected()];
				const t = token();
				// Exact match typed out: Enter submits; otherwise it completes.
				if (sel && t && sel.label !== `/${t.query}` && sel.label !== `@${t.query}`) {
					e.preventDefault();
					apply(sel);
					return;
				}
			}
		}
		if (e.key === "Escape" && state.streaming) {
			e.preventDefault();
			lastEsc = 0;
			void call("abort").catch(err => setState("error", String(err)));
			return;
		}
		if (e.key === "Escape") {
			// Double-Esc on an empty textarea opens the branch picker (TUI
			// parity); Esc with text just resets the chord timer.
			if (message().trim() === "") {
				const now = Date.now();
				if (now - lastEsc <= 500) {
					lastEsc = 0;
					setState("modal", "branch");
				} else lastEsc = now;
			} else lastEsc = 0;
			return;
		}
		if (e.key === "Enter") {
			if (e.shiftKey) return; // newline
			e.preventDefault();
			submit(e.ctrlKey || e.metaKey ? "followup" : "enter");
			return;
		}
		const el = e.currentTarget as HTMLTextAreaElement;
		if (e.key === "ArrowUp" && !el.value.slice(0, el.selectionStart).includes("\n")) {
			const recalled = history.prev(message());
			if (recalled !== null) {
				e.preventDefault();
				setMessage(recalled);
				requestAnimationFrame(autoGrow);
			}
			return;
		}
		if (e.key === "ArrowDown" && history.browsing && !el.value.slice(el.selectionEnd).includes("\n")) {
			const next = history.next();
			if (next !== null) {
				e.preventDefault();
				setMessage(next);
				requestAnimationFrame(autoGrow);
			}
		}
	};

	return (
		<div class="prompt-box">
			{images().length > 0 && (
				<div class="image-tray">
					<For each={images()}>
						{(img, i) => (
							<span class="image-thumb">
								<img src={`data:${img.mimeType};base64,${img.data}`} alt="pasted" />
								<button class="image-remove" onClick={() => setImages(prev => prev.filter((_, j) => j !== i()))}>
									×
								</button>
							</span>
						)}
					</For>
				</div>
			)}
			<div class="prompt-input">
				{open() && (
					<Autocomplete items={items()} selected={selected()} onHover={setSelected} onApply={apply} />
				)}
				<textarea
					ref={textarea}
					value={message()}
					onInput={e => {
						setMessage(e.currentTarget.value);
						setDismissed(false);
						setSelected(0);
						autoGrow();
						refreshToken();
					}}
					onKeyDown={onKeyDown}
					onKeyUp={refreshToken}
					onClick={refreshToken}
					onPaste={onPaste}
					placeholder="Message the agent… (Enter send, Ctrl+Enter follow-up, / for commands)"
					rows={3}
				/>
			</div>
			<div class="prompt-actions">
				<button class="new-session" onClick={() => dispatchInput("/new", undefined, "enter")}>
					New session
				</button>
				{state.streaming && (
					<button class="stop" onClick={() => void call("abort").catch(err => setState("error", String(err)))}>
						Stop
					</button>
				)}
				<button class="send" onClick={() => submit("enter")} disabled={!message().trim() && images().length === 0}>
					{state.streaming ? "Steer" : "Send"}
				</button>
			</div>
		</div>
	);
};
