import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { SubagentMessagesResult } from "#lib/wire/protocol";
import type { SessionMessageEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { createEffect, createSignal, For, on, onCleanup, Show, type Component } from "solid-js";
import { type SubagentInfo } from "../../state";
import {
	abortSubagent,
	steerSubagent,
	parkWorker,
	resumeWorker,
	reviveWorker,
} from "../../store/subagents";
import { call } from "../../store/transport";
import { pushNotice } from "../../store/chat";
import { ArrowLeftIcon } from "../shared/icons";
import { ConfirmButton } from "../shared/ConfirmButton";
import { Inspector, type InspectorTab } from "./Inspector";
import {
	canAbort,
	canPark,
	canResume,
	canRevive,
	classifyLifecycleError,
	getFocusDraft,
	getWorkerPin,
	isWorkerUnread,
	markWorkerSeen,
	setFocusDraft,
	setWorkerPin,
	steerBlockReason,
	workerModel,
	type WorkerPin,
} from "./workerScope";

type AssistantContent = Extract<AgentMessage, { role: "assistant" }>["content"];

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
				return <div style={{ "white-space": "pre-wrap" }}>{block.text}</div>;
			}
			if (block.type === "thinking") {
				return (
					<div class="dim-block" style={{ "white-space": "pre-wrap" }}>
						{block.thinking}
					</div>
				);
			}
			if (block.type === "toolCall") {
				return (
					<details class="tool-collapsed-note">
						<summary>tool: {block.name}</summary>
						<pre style={{ "white-space": "pre-wrap" }}>
							{JSON.stringify(block.arguments, null, 2)}
						</pre>
					</details>
				);
			}
			return null;
		}}
	</For>
);

const MessageView: Component<{ msg: AgentMessage }> = (props) => {
	if (props.msg.role === "user") {
		const content = props.msg.content as Parameters<typeof flattenParts>[0];
		return <div class="msg-user">{flattenParts(content)}</div>;
	}
	if (props.msg.role === "assistant") {
		return <AssistantBlocks content={props.msg.content} />;
	}
	if (props.msg.role === "toolResult") {
		const content = props.msg.content as Parameters<typeof flattenParts>[0];
		return (
			<pre class="dim-block" style={{ margin: "0", "white-space": "pre-wrap" }}>
				{flattenParts(content)}
			</pre>
		);
	}
	return null;
};

/**
 * Focused worker view (G04/G10).
 *
 * Transcript paging uses stable session-file byte anchors (fromByte/nextByte):
 * `reset === true` replaces all + notice (replay-gap resync), otherwise
 * appends; streaming never reorders (append-only). Draft ownership is
 * partitioned by focused worker: the composer buffer lives in the module
 * focus-draft map keyed `focusKey(sessionId, agentId)`; the Main draft is
 * preserved in localStorage (`omp.mainDraft.<sessionId>`) on focus and
 * restored with a notice on return — never in the shared store facade.
 *
 * Lifecycle actions (park/revive/resume/abort) use lifecycle-specific confirms:
 * abort keeps the existing confirm; tombstoned (aborted) workers never show
 * revive; Main never appears here (the mirror tracks subagents only).
 */
export const WorkerFocus: Component<{
	sub: SubagentInfo;
	sessionId: string;
	follow: boolean;
	onFollowChange: (follow: boolean) => void;
	onBack: () => void;
}> = (props) => {
	const [messages, setMessages] = createSignal<SessionMessageEntry[]>([]);
	const [hasMore, setHasMore] = createSignal(false);
	const [nextByte, setNextByte] = createSignal(0);
	const [loading, setLoading] = createSignal(false);
	const [error, setError] = createSignal<string | null>(null);
	const [steerText, setSteerText] = createSignal("");
	const [pending, setPending] = createSignal(false);
	const [tab, setTab] = createSignal<InspectorTab>("context");
	const [showInspector, setShowInspector] = createSignal(true);
	const [pin, setPin] = createSignal<WorkerPin>("full");
	const [notice, setNotice] = createSignal<string | null>(null);
	let scopeRevision = 0;

	const draftKey = () => `${props.sessionId}::${props.sub.id}`;
	const blockReason = () => steerBlockReason(props.sub);
	const model = () => workerModel(props.sub);

	const load = async (from?: number): Promise<void> => {
		if (loading()) return;
		const revision = scopeRevision;
		const agentId = props.sub.id;
		setLoading(true);
		setError(null);
		try {
			const args: { subagentId: string; fromByte?: number } = { subagentId: agentId };
			if (from !== undefined) args.fromByte = from;
			const res = (await call("getSubagentMessages", [args])) as SubagentMessagesResult & {
				hasMore?: boolean;
			};
			if (revision !== scopeRevision) return;
			const incoming = res.entries.filter(
				(entry): entry is SessionMessageEntry => entry.type === "message",
			);
			if (from === undefined || res.reset) {
				if (res.reset && from !== undefined)
					setNotice("transcript reset — resynced after replay gap");
				setMessages(incoming);
			} else {
				// Preserve-while-streaming: append-only, never reorder.
				setMessages((prev) => {
					const known = new Set(prev.map((entry) => entry.id));
					return [...prev, ...incoming.filter((entry) => !known.has(entry.id))];
				});
			}
			setNextByte(res.nextByte);
			setHasMore(res.hasMore === true);
		} catch (e) {
			if (revision === scopeRevision) setError(e instanceof Error ? e.message : String(e));
		} finally {
			if (revision === scopeRevision) setLoading(false);
		}
	};

	const steer = async (): Promise<void> => {
		const text = steerText().trim();
		if (!text || pending() || blockReason() !== null) return;
		setPending(true);
		try {
			await steerSubagent(props.sub.id, text);
			setSteerText("");
			setFocusDraft(draftKey(), "");
		} catch (err) {
			pushNotice("error", err instanceof Error ? err.message : String(err));
		} finally {
			setPending(false);
		}
	};

	const withPending = async (work: () => Promise<string | null>): Promise<void> => {
		if (pending()) return;
		setPending(true);
		try {
			const text = await work();
			if (text) setNotice(text);
		} catch (err) {
			setNotice(err instanceof Error ? err.message : String(err));
		} finally {
			setPending(false);
		}
	};

	const park = (): Promise<void> =>
		withPending(async () => {
			// Park coalesced race: the manager no-ops unless adopted/live.
			const result = await parkWorker(props.sub.id);
			return result.parked
				? `parked ${result.id}`
				: `park no-op: ${result.status || props.sub.status}`;
		});

	const restore = (action: "revive" | "resume"): Promise<void> =>
		withPending(async () => {
			try {
				const result = await (action === "revive"
					? reviveWorker(props.sub.id)
					: resumeWorker(props.sub.id));
				return `${action === "revive" ? "revived" : "resumed"} ${result.id} · ${result.status}`;
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				const kind = classifyLifecycleError(message);
				if (kind === "terminal") return `${action} refused: terminal worker (${message})`;
				if (kind === "unavailable")
					return `${action} unavailable: missing history or artifacts (${message})`;
				if (kind === "no-such-agent") return `${action} failed: no such agent (${message})`;
				throw err;
			}
		});

	const abort = async (): Promise<void> => {
		if (pending()) return;
		setPending(true);
		try {
			await abortSubagent(props.sub.id);
		} catch (err) {
			pushNotice("error", err instanceof Error ? err.message : String(err));
		} finally {
			setPending(false);
		}
	};

	const backToMain = (): void => {
		props.onBack();
	};

	createEffect(
		on(
			() => `${props.sessionId}::${props.sub.id}`,
			(key, previous) => {
				if (previous) setFocusDraft(previous, steerText());
				scopeRevision++;
				setMessages([]);
				setNextByte(0);
				setHasMore(false);
				setLoading(false);
				setError(null);
				setNotice(null);
				setSteerText(getFocusDraft(key));
				setPin(getWorkerPin(props.sub.id));
				markWorkerSeen(props.sub);
				void load();
			},
		),
	);
	onCleanup(() => {
		scopeRevision++;
		setFocusDraft(draftKey(), steerText());
	});

	createEffect(
		on(
			() => [props.sub.lastUpdate, props.follow] as const,
			() => {
				markWorkerSeen(props.sub);
				if (props.follow && !loading()) void load(nextByte());
			},
			{ defer: true },
		),
	);

	return (
		<div class="subagent-list">
			<div class="subagent-panel-row">
				<button type="button" onClick={props.onBack}>
					<ArrowLeftIcon /> back
				</button>
				<span class="subagent-status">
					{props.sub.agent} · {props.sub.status}
					<Show when={model()}> · {model()}</Show>
				</span>
				<Show when={isWorkerUnread(props.sub)}>
					<span class="subagent-status" aria-label="unread activity">
						●
					</span>
				</Show>
				<label class="subagent-status">
					<input
						type="checkbox"
						checked={props.follow}
						onChange={(e) => props.onFollowChange(e.currentTarget.checked)}
					/>{" "}
					follow
				</label>
				<label class="subagent-status">
					pin{" "}
					<select
						value={pin()}
						onChange={(e) => {
							const next = e.currentTarget.value as WorkerPin;
							setPin(next);
							setWorkerPin(props.sub.id, next);
						}}
					>
						<option value="full">full</option>
						<option value="collapsed">collapsed</option>
						<option value="off">off</option>
					</select>
				</label>
			</div>

			<Show when={notice()}>{(text) => <div class="msg-notice">{text()}</div>}</Show>

			<Show when={pin() === "full"}>
				<For each={messages()}>
					{(entry) => (
						<div data-entry-id={entry.id}>
							<MessageView msg={entry.message} />
						</div>
					)}
				</For>
				{messages().length === 0 && !loading() && !error() && (
					<div class="tool-collapsed-note">no messages</div>
				)}
				<Show when={error()}>{(err) => <div class="msg-notice">{err()}</div>}</Show>
				<button type="button" disabled={loading()} onClick={() => void load(nextByte())}>
					{loading() ? "loading…" : hasMore() ? "load next page" : "load newer"}
				</button>

				<Show
					when={blockReason() === null}
					fallback={
						<div class="tool-collapsed-note" role="note">
							read-only — {blockReason()}
						</div>
					}
				>
					<div class="subagent-controls">
						<input
							class="picker-filter"
							type="text"
							aria-label="Steer worker"
							placeholder="steer…"
							value={steerText()}
							disabled={pending()}
							onInput={(e) => {
								setSteerText(e.currentTarget.value);
								setFocusDraft(draftKey(), e.currentTarget.value);
							}}
							onKeyDown={(e) => {
								if (e.key === "Enter") void steer();
							}}
						/>
						<button
							type="button"
							disabled={pending() || !steerText().trim()}
							onClick={() => void steer()}
						>
							steer
						</button>
					</div>
				</Show>

				<div class="subagent-controls">
					<Show when={canPark(props.sub)}>
						<ConfirmButton label="park" confirmLabel="confirm park" onConfirm={() => void park()} />
					</Show>
					<Show when={canRevive(props.sub)}>
						<ConfirmButton
							label="revive"
							confirmLabel={`confirm revive ${props.sub.id}`}
							onConfirm={() => void restore("revive")}
						/>
					</Show>
					<Show when={canResume(props.sub)}>
						<ConfirmButton
							label="resume"
							confirmLabel="confirm resume"
							onConfirm={() => void restore("resume")}
						/>
					</Show>
					<Show when={canAbort(props.sub)}>
						<ConfirmButton label="abort" confirmLabel="confirm" onConfirm={() => void abort()} />
					</Show>
					<button type="button" onClick={backToMain}>
						return to Main
					</button>
					<button type="button" onClick={() => setShowInspector((v) => !v)}>
						{showInspector() ? "hide inspector" : "show inspector"}
					</button>
				</div>

				<Show when={showInspector()}>
					<div class="subagent-controls" role="tablist" aria-label="Worker inspector">
						<button
							type="button"
							role="tab"
							aria-selected={tab() === "context"}
							onClick={() => setTab("context")}
						>
							context
						</button>
						<button
							type="button"
							role="tab"
							aria-selected={tab() === "lineage"}
							onClick={() => setTab("lineage")}
						>
							lineage
						</button>
						<button
							type="button"
							role="tab"
							aria-selected={tab() === "patch"}
							onClick={() => setTab("patch")}
						>
							patch
						</button>
						<button
							type="button"
							role="tab"
							aria-selected={tab() === "output"}
							onClick={() => setTab("output")}
						>
							output
						</button>
					</div>
					<Inspector sub={props.sub} tab={tab()} />
				</Show>
			</Show>
			<Show when={pin() === "collapsed"}>
				<div class="subagent-controls">
					<Show when={canPark(props.sub)}>
						<ConfirmButton label="park" confirmLabel="confirm park" onConfirm={() => void park()} />
					</Show>
					<Show when={canRevive(props.sub)}>
						<ConfirmButton
							label="revive"
							confirmLabel={`confirm revive ${props.sub.id}`}
							onConfirm={() => void restore("revive")}
						/>
					</Show>
					<Show when={canResume(props.sub)}>
						<ConfirmButton
							label="resume"
							confirmLabel="confirm resume"
							onConfirm={() => void restore("resume")}
						/>
					</Show>
					<Show when={canAbort(props.sub)}>
						<ConfirmButton label="abort" confirmLabel="confirm" onConfirm={() => void abort()} />
					</Show>
					<button type="button" onClick={backToMain}>
						return to Main
					</button>
				</div>
			</Show>
			<Show when={pin() === "off"}>
				<div class="tool-collapsed-note">hidden by pin pref — restore via pin select above</div>
			</Show>
		</div>
	);
};
