import { PromptCacheSegment } from "../../../../web/components/chat/status/PromptCacheSegment";
import { SessionConfigBar } from "../../../../web/components/chat/status/SessionConfigBar";
import { promptCacheFixture, type PromptCacheFixtureName } from "../../../fixtures/prompt-cache";
import { screenSessionSeed } from "../../../fixtures/screen";
import { answerCalls } from "../../../session";
import { defineStory } from "../../../registry";

/** The session answers `getPromptCacheStatus` with `name`'s fixture. */
const cacheSeed = (name: PromptCacheFixtureName) => () =>
	answerCalls({ getPromptCacheStatus: () => promptCacheFixture(name) });

export default defineStory({
	id: "chat-status-prompt-cache-segment",
	title: "PromptCacheSegment",
	component: {
		file: "apps/web/components/chat/status/PromptCacheSegment.tsx",
		export: "PromptCacheSegment",
	},
	seed: screenSessionSeed,
	variants: [
		{
			name: "Warm",
			description:
				"The next message reads the cache. Click the chip for the session's brief and detail rows.",
			seed: cacheSeed("warm"),
			render: () => <SessionConfigBar />,
		},
		{
			name: "Likely warm",
			description:
				"Inferred from a reopened session's transcript, not a response this process saw.",
			seed: cacheSeed("likely"),
			render: () => <SessionConfigBar />,
		},
		{
			name: "Cold with reason",
			description:
				"The next message re-sends the prefix; the chip turns to the warning tone and the popover says why.",
			seed: cacheSeed("cold"),
			render: () => <SessionConfigBar />,
		},
		{
			name: "Warming scheduled",
			description: "A warm entry with omp's refresh armed: the popover adds the Warming row.",
			seed: cacheSeed("warming"),
			render: () => <SessionConfigBar />,
		},
		{
			name: "Hidden",
			description:
				"The session has nothing to report (no cache warmer, or no cached reply): the chip is not shown.",
			seed: cacheSeed("none"),
			render: () => <SessionConfigBar />,
		},
		{
			name: "Chip alone",
			description: "The segment without the rest of the bar.",
			seed: cacheSeed("warm"),
			render: () => (
				<div class="session-bar">
					<PromptCacheSegment />
				</div>
			),
		},
	],
});
