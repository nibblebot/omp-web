/**
 * Renders ```mermaid fences as diagrams in the browser.
 *
 * Starlight's code blocks (Expressive Code) have no Mermaid support, and the
 * Markdown pipeline here has no remark stage to hook into, so the diagrams
 * stay plain `mermaid` fences in the source (GitHub renders those natively).
 * This script, injected on every docs page by the integration in
 * `astro.config.mjs`, finds the rendered code blocks, replaces each with the
 * SVG Mermaid draws from its text, and redraws them when the reader switches
 * between the light and dark theme. Mermaid itself is imported only when a
 * page has a diagram. A diagram that fails to render, or a page whose Mermaid
 * chunk fails to load (a tab left open across a redeploy, offline), keeps its
 * code block.
 */

import type mermaidApi from "mermaid";

const SELECTOR = 'pre[data-language="mermaid"]';

interface Diagram {
	readonly host: HTMLElement;
	readonly source: string;
}

function collect(): Diagram[] {
	const diagrams: Diagram[] = [];
	for (const pre of document.querySelectorAll(SELECTOR)) {
		const block = pre.closest<HTMLElement>(".expressive-code");
		if (!block) continue;
		const host = document.createElement("div");
		host.className = "mermaid-diagram";
		block.after(host);
		// Each `.ec-line > .code` element is one line of the fence's text.
		const lines = Array.from(
			pre.querySelectorAll(".ec-line .code"),
			(line) => line.textContent ?? "",
		);
		diagrams.push({ host, source: lines.join("\n") });
		block.hidden = true;
	}
	return diagrams;
}

async function main(): Promise<void> {
	const diagrams = collect();
	if (diagrams.length === 0) return;
	// Dynamic on purpose: Mermaid is large, and only pages with a diagram pay for it.
	let mermaid: typeof mermaidApi;
	try {
		({ default: mermaid } = await import("mermaid"));
	} catch (error) {
		console.error("omp-web docs: mermaid failed to load", error);
		for (const { host } of diagrams) {
			host.previousElementSibling?.removeAttribute("hidden");
			host.remove();
		}
		return;
	}
	let generation = 0;
	const draw = async (): Promise<void> => {
		const dark = document.documentElement.dataset.theme !== "light";
		mermaid.initialize({
			startOnLoad: false,
			theme: dark ? "dark" : "default",
			securityLevel: "strict",
		});
		const current = ++generation;
		for (const [index, diagram] of diagrams.entries()) {
			try {
				const { svg } = await mermaid.render(`mermaid-diagram-${current}-${index}`, diagram.source);
				if (current !== generation) return;
				diagram.host.innerHTML = svg;
				diagram.host.previousElementSibling?.setAttribute("hidden", "");
			} catch (error) {
				console.error("omp-web docs: mermaid diagram failed to render", error);
				diagram.host.replaceChildren();
				diagram.host.previousElementSibling?.removeAttribute("hidden");
			}
		}
	};
	await draw();
	new MutationObserver(() => void draw()).observe(document.documentElement, {
		attributes: true,
		attributeFilter: ["data-theme"],
	});
}

void main();
