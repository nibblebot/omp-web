import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { SubagentMessagesResult } from "../../../shared/protocol";
import { createSignal, For, onMount, Show, type Component } from "solid-js";
import { call, type SubagentInfo } from "../../state";
import { ArrowLeftIcon } from "../shared/icons";

const MAX_CHARS = 500;

type AssistantContent = Extract<AgentMessage, { role: "assistant" }>["content"];

const clip = (text: string): string =>
	text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}…` : text;

// `.content` is a string or (TextContent | ImageContent)[] across user + toolResult
// messages in pi-ai; flatten to one string with `[image]` placeholders.
const flattenParts = (parts: string | { type: string; text?: string }[]): string =>
	typeof parts === "string"
		? parts
		: parts.map((c) => (c.type === "text" ? (c.text ?? "") : "[image]")).join("\n");

const AssistantBlocks: Component<{ content: AssistantContent }> = (props) => (
	<For each={props.content}>
		{(block) => {
			if (block.type === "text") {
				return <div style={{ "white-space": "pre-wrap" }}>{clip(block.text)}</div>;
			}
			if (block.type === "thinking") {
				return (
					<div class="dim-block" style={{ "white-space": "pre-wrap" }}>
						{clip(block.thinking)}
					</div>
				);
			}
			if (block.type === "toolCall") {
				return <div class="tool-collapsed-note">tool: {block.name}</div>;
			}
			return null;
		}}
	</For>
);

const MessageView: Component<{ msg: AgentMessage }> = (props) => {
	if (props.msg.role === "user") {
		const content = props.msg.content as Parameters<typeof flattenParts>[0];
		return <div class="msg-user">{clip(flattenParts(content))}</div>;
	}
	if (props.msg.role === "assistant") {
		return <AssistantBlocks content={props.msg.content} />;
	}
	if (props.msg.role === "toolResult") {
		const content = props.msg.content as Parameters<typeof flattenParts>[0];
		return (
			<pre class="dim-block" style={{ margin: "0", "white-space": "pre-wrap" }}>
				{clip(flattenParts(content))}
			</pre>
		);
	}
	return null;
};

/** Read-only transcript of one subagent, paged by session-file byte offsets. */
export const SubagentDetail: Component<{ sub: SubagentInfo; onBack: () => void }> = (props) => {
	const [messages, setMessages] = createSignal<AgentMessage[]>([]);
	const [fromByte, setFromByte] = createSignal(0);
	const [nextByte, setNextByte] = createSignal(0);
	const [loading, setLoading] = createSignal(false);
	const [error, setError] = createSignal<string | null>(null);

	const load = async (from?: number): Promise<void> => {
		if (loading()) return;
		setLoading(true);
		setError(null);
		try {
			const args: { subagentId: string; fromByte?: number } = { subagentId: props.sub.id };
			if (from !== undefined) args.fromByte = from;
			const res = (await call("getSubagentMessages", [args])) as SubagentMessagesResult;
			setMessages((prev) =>
				from === undefined || res.reset ? res.messages : [...prev, ...res.messages],
			);
			setFromByte(res.fromByte);
			setNextByte(res.nextByte);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setLoading(false);
		}
	};

	// Initial fetch runs once: this component remounts per selected subagent.
	onMount(() => void load());

	return (
		<div class="subagent-list">
			<button type="button" style={{ "align-self": "flex-start" }} onClick={props.onBack}>
				<ArrowLeftIcon /> back
			</button>
			<For each={messages()}>{(msg) => <MessageView msg={msg} />}</For>
			{messages().length === 0 && !loading() && !error() && (
				<div class="tool-collapsed-note">no messages</div>
			)}
			<Show when={error()}>{(err) => <div class="msg-notice">{err()}</div>}</Show>
			<Show when={nextByte() > fromByte()}>
				<button type="button" disabled={loading()} onClick={() => void load(nextByte())}>
					{loading() ? "loading…" : "load newer"}
				</button>
			</Show>
		</div>
	);
};
