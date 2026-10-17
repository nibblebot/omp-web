import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { For, Show, type Component } from "solid-js";
import { loadMoreSubagentTranscript, subagentTranscript } from "../../store/subagents";

type AssistantContent = Extract<AgentMessage, { role: "assistant" }>["content"];

type RoleMessage<R extends AgentMessage["role"]> = Extract<AgentMessage, { role: R }>;

// `.content` is a string or (TextContent | ImageContent)[] across user + toolResult
// messages in pi-ai; flatten to one string with `[image]` placeholders.
type MessageContent = string | { type: string; text?: string }[];
const flattenParts = (parts: MessageContent): string =>
	typeof parts === "string"
		? parts
		: parts.map((c) => (c.type === "text" ? (c.text ?? "") : "[image]")).join("\n");

const AssistantBlocks: Component<{ content: AssistantContent }> = (props) => (
	<For each={props.content}>
		{(block) => {
			if (block.type === "text") return <div class="subagent-prose">{block.text}</div>;
			if (block.type === "thinking") {
				return <div class="dim-block subagent-prose">{block.thinking}</div>;
			}
			if (block.type === "toolCall") {
				return (
					<details class="tool-collapsed-note">
						<summary>tool: {block.name}</summary>
						<pre class="subagent-prose">{JSON.stringify(block.arguments, null, 2)}</pre>
					</details>
				);
			}
			return null;
		}}
	</For>
);

const MessageView: Component<{ msg: AgentMessage }> = (props) => (
	<>
		<Show when={props.msg.role === "user"}>
			<div class="msg-user subagent-prose">
				{flattenParts((props.msg as RoleMessage<"user">).content as MessageContent)}
			</div>
		</Show>
		<Show when={props.msg.role === "assistant"}>
			<AssistantBlocks content={(props.msg as RoleMessage<"assistant">).content} />
		</Show>
		<Show when={props.msg.role === "toolResult"}>
			<pre class="dim-block subagent-prose">
				{flattenParts((props.msg as RoleMessage<"toolResult">).content as MessageContent)}
			</pre>
		</Show>
	</>
);

/** Readable transcript of one agent, with paging through earlier messages. */
export const SubagentTranscript: Component<{ id: string }> = (props) => {
	const transcript = () => subagentTranscript(props.id);
	return (
		<div class="subagent-transcript">
			<Show when={transcript().hasMore}>
				<button
					type="button"
					class="subagent-transcript-more"
					disabled={transcript().loading}
					onClick={() => void loadMoreSubagentTranscript(props.id)}
				>
					Load earlier messages
				</button>
			</Show>
			<For each={transcript().entries}>
				{(entry) => (
					<div class="subagent-message" data-entry-id={entry.id}>
						<MessageView msg={entry.message} />
					</div>
				)}
			</For>
			<Show when={transcript().loading}>
				<p class="subagent-transcript-status">Loading transcript…</p>
			</Show>
			<Show when={transcript().error}>
				{(error) => (
					<p class="subagent-transcript-error" role="alert">
						{error()}
					</p>
				)}
			</Show>
		</div>
	);
};
