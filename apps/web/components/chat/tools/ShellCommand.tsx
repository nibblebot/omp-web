import { createEffect, createSignal, on, onCleanup, onMount, Show, type Component } from "solid-js";
import { state } from "../../../state";
import { HighlightedText } from "./HighlightedText";

/** Prompt glyph per command language, as the TUI prints it. */
const PROMPT = { bash: "$", python: ">>>" } as const;

/**
 * A command behind its prompt glyph, highlighted and wrapped onto as many rows
 * as it needs. Past the row cap (tools.css `.shell-command--clamped`) it shows
 * its first rows and a per-command "Show full command" toggle; Ctrl+O
 * (toolsExpanded) lifts every cap. Running commands clamp like settled ones.
 */
export const ShellCommand: Component<{ command: string; lang: keyof typeof PROMPT }> = (props) => {
	let textRef!: HTMLSpanElement;
	const [userExpanded, setUserExpanded] = createSignal(false);
	const [hiddenRows, setHiddenRows] = createSignal(0);
	// Ctrl+O resets the per-command choice, as ToolCardShell does for cards.
	createEffect(
		on(
			() => state.toolsExpanded,
			() => setUserExpanded(false),
			{ defer: true },
		),
	);
	const expanded = () => state.toolsExpanded || userExpanded();
	// Measured only while clamped; "Show less" keeps the count from the last clamped layout.
	const measure = () => {
		if (expanded()) return;
		const overflow = textRef.scrollHeight - textRef.clientHeight;
		const row = Number.parseFloat(getComputedStyle(textRef).lineHeight);
		setHiddenRows(overflow <= 1 ? 0 : row > 0 ? Math.max(1, Math.round(overflow / row)) : 1);
	};
	onMount(() => {
		// Width changes rewrap the command; a clamped box keeps its height as the command grows, so
		// the effect below re-measures on content changes.
		const observer = new ResizeObserver(measure);
		observer.observe(textRef);
		onCleanup(() => observer.disconnect());
	});
	createEffect(on([() => props.command, expanded], measure, { defer: true }));
	return (
		<div class="shell-command" classList={{ "shell-command--clamped": !expanded() }}>
			<span class="shell-command-text" ref={textRef}>
				<span class="shell-command-prompt">{PROMPT[props.lang]} </span>
				<HighlightedText code={props.command} lang={props.lang} />
			</span>
			<Show when={!state.toolsExpanded && hiddenRows() > 0}>
				<button
					class="shell-command-toggle"
					type="button"
					aria-expanded={userExpanded()}
					onClick={() => setUserExpanded(!userExpanded())}
				>
					{userExpanded()
						? "Show less"
						: `Show full command (${hiddenRows()} more ${hiddenRows() === 1 ? "line" : "lines"})`}
				</button>
			</Show>
		</div>
	);
};
