import { Toasts } from "../../../web/components/app/Toasts";
import { setState } from "../../../web/state";
import { pushToast } from "../../../web/store/toasts";
import { defineStory } from "../../registry";

export default defineStory({
	id: "app-toasts",
	title: "Toasts",
	component: { file: "apps/web/components/app/Toasts.tsx", export: "Toasts" },
	variants: [
		{
			name: "Single notice",
			seed: () => pushToast("Session saved to .omp/sessions/sess_09a41c.jsonl"),
			render: () => (
				<div class="ds-frame">
					<Toasts />
				</div>
			),
		},
		{
			name: "With action",
			description: "Undo toast from discarding a draft; stays for 10 s.",
			seed: () =>
				pushToast("Draft discarded", {
					durationMs: 10_000,
					action: { label: "Undo", run: () => {} },
				}),
			render: () => (
				<div class="ds-frame">
					<Toasts />
				</div>
			),
		},
		{
			name: "Stacked notices",
			description: "Several toasts queued by different actions.",
			seed: () => {
				pushToast("Model switched to claude-sonnet-4");
				pushToast("Context compacted: 84k to 31k tokens");
				pushToast("Skill refresh finished: 14 skills loaded");
			},
			render: () => (
				<div class="ds-frame">
					<Toasts />
				</div>
			),
		},
		{
			name: "Long message",
			seed: () =>
				pushToast(
					"Could not reach the Linear MCP server after 3 attempts. Check the OAuth token in Settings > Integrations, then retry the tool call.",
				),
			render: () => (
				<div class="ds-frame">
					<Toasts />
				</div>
			),
		},
		{
			name: "Error",
			description: "state.error renders as a sticky error toast until dismissed or replaced.",
			seed: { error: 'command "attach" rejected: unknown daemon: d9' },
			render: () => (
				<div class="ds-frame">
					<Toasts />
				</div>
			),
		},
		{
			name: "Error with notices",
			seed: () => {
				pushToast("Model switched to claude-sonnet-4");
				setState("error", "Provider returned 429: rate limit reached.");
			},
			render: () => (
				<div class="ds-frame">
					<Toasts />
				</div>
			),
		},
	],
});
