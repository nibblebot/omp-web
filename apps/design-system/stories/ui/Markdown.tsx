import { Markdown } from "../../../web/components/ui/Markdown";
import {
	markdownAnswer,
	markdownCodeFences,
	markdownLong,
	markdownTableAnswer,
	markdownUntrusted,
} from "../../fixtures/shared";
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
			name: "Answer with a table",
			description:
				"A heading, a table with centered and left aligned columns, inline code and a fenced block.",
			render: () => <Markdown src={markdownTableAnswer} />,
		},
		{
			name: "Code fences",
			description:
				"Closed fences (ts, bash, json, diff) are syntax highlighted; unlabelled, unknown-language, and still-streaming fences stay plain.",
			render: () => <Markdown src={markdownCodeFences} />,
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
