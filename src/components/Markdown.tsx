import { createMemo, type Component } from "solid-js";
import { renderMarkdown } from "../markdown";

// Parses only when `src` changes — frozen paragraphs parse exactly once.
export const Markdown: Component<{ src: string }> = props => {
	const html = createMemo(() => renderMarkdown(props.src));
	// eslint-disable-next-line solid/no-innerhtml -- sanitized by DOMPurify in renderMarkdown
	return <div class="md" innerHTML={html()} />;
};
