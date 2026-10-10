import { Markdown } from "../../../web/components/ui/Markdown";
import { markdownAnswer, markdownLong, markdownUntrusted } from "../../fixtures/shared";
import { defineStory } from "../../registry";

export default defineStory({
	id: "ui-markdown",
	title: "Markdown",
	component: { file: "apps/web/components/ui/Markdown.tsx", export: "Markdown" },
	variants: [
		{
			name: "Assistant answer",
			description:
				"Headings, inline code, a fenced block, a list, and a link, as in a typical agent reply.",
			render: () => <Markdown src={markdownAnswer} />,
		},
		{
			name: "Untrusted HTML",
			description:
				"Raw script, image handler, and javascript: link in the source. None of them may execute or render as live markup.",
			render: () => <Markdown src={markdownUntrusted} />,
		},
		{
			name: "Long review",
			description:
				"Several sections, a long fenced block, and a wide table, to check wrapping and scrolling.",
			render: () => <Markdown src={markdownLong} />,
		},
	],
});
