import { createEffect, createMemo, type Component } from "solid-js";
import { renderMarkdown } from "../markdown";
import { COPY_FEEDBACK_MS } from "./CopyButton";

/** navigator.clipboard with a textarea fallback for non-secure origins. */
export async function copyText(text: string): Promise<boolean> {
	try {
		if (navigator.clipboard?.writeText) {
			await navigator.clipboard.writeText(text);
			return true;
		}
	} catch {
		// fall through to the textarea path
	}
	try {
		const ta = document.createElement("textarea");
		ta.value = text;
		ta.style.position = "fixed";
		ta.style.opacity = "0";
		document.body.appendChild(ta);
		ta.select();
		const ok = document.execCommand("copy");
		ta.remove();
		return ok;
	} catch {
		return false;
	}
}

/**
 * Adds a top-right copy button to every fenced code block. Runs after
 * innerHTML is (re)set, so DOMPurify sanitization is untouched and streaming
 * re-renders just get re-decorated.
 */
function decorateCodeBlocks(root: HTMLElement): void {
	for (const pre of root.querySelectorAll("pre")) {
		if (pre.querySelector(":scope > .code-copy-btn")) continue;
		const btn = document.createElement("button");
		btn.type = "button";
		btn.className = "code-copy-btn";
		btn.textContent = "copy";
		btn.addEventListener("click", () => {
			const text = pre.querySelector("code")?.textContent ?? pre.textContent ?? "";
			void copyText(text).then((ok) => {
				btn.textContent = ok ? "copied" : "failed";
				setTimeout(() => {
					btn.textContent = "copy";
				}, COPY_FEEDBACK_MS);
			});
		});
		pre.appendChild(btn);
	}
}

// Parses only when `src` changes — frozen paragraphs parse exactly once.
export const Markdown: Component<{ src: string }> = (props) => {
	const html = createMemo(() => renderMarkdown(props.src));
	let el!: HTMLDivElement;
	// Set innerHTML inside the same effect as decoration: ordering is
	// guaranteed, unlike a separate JSX binding + effect pair.
	createEffect(() => {
		// eslint-disable-next-line solid/no-innerhtml -- sanitized by DOMPurify in renderMarkdown
		el.innerHTML = html();
		decorateCodeBlocks(el);
	});
	return <div class="md" ref={el} />;
};
