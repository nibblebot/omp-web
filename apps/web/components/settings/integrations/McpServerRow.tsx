import { For, Show, type Component } from "solid-js";
import type { McpConnectionState, McpScope, McpServerSummary } from "#lib/wire/protocol";
import {
	disableMcpServer,
	enableMcpServer,
	inspectMcp,
	mcpInspection,
	mcpInspecting,
	mcpTestResult,
	reconnectMcpServer,
	removeMcpServer,
	revokeMcpOAuth,
	testMcpServer,
} from "../../../store/integrations";

const STATUS_LABEL: Record<McpConnectionState, string> = {
	connected: "connected",
	connecting: "connecting",
	disconnected: "not connected",
	disabled: "disabled",
};

/** One configured MCP server: status, what runs, and the actions the write path supports. */
export const McpServerRow: Component<{
	server: McpServerSummary;
	onEdit: (server: McpServerSummary) => void;
}> = (props) => {
	const s = () => props.server;

	/** The scope a remove or edit can target; null for servers declared by a third-party config. */
	const writableScope = (): McpScope | null => {
		const scope = props.server.scope;
		return props.server.writable && scope !== "discovered" ? scope : null;
	};

	const target = () =>
		s().transport === "stdio" ? [s().command, ...(s().args ?? [])].join(" ") : (s().url ?? "");

	const testResult = () => {
		const result = mcpTestResult();
		return result && result.server === s().name ? result.result : null;
	};
	const inspection = () => {
		const result = mcpInspection();
		return result && result.server === s().name ? result.inspection : null;
	};

	const toggle = () => (s().enabled ? disableMcpServer(s().name) : enableMcpServer(s().name));

	return (
		<li class="integrations-row" data-status={s().status}>
			<div class="integrations-row-head">
				<span class={`integrations-dot integrations-dot-${s().status}`} aria-hidden="true" />
				<strong class="integrations-row-name">{s().name}</strong>
				<span class="integrations-badge">{s().transport}</span>
				<span class="integrations-badge">{STATUS_LABEL[s().status]}</span>
				<Show
					when={s().scope === "discovered"}
					fallback={<span class="integrations-badge">{s().scope} config</span>}
				>
					<span class="integrations-badge">{s().source ?? "discovered"} · read-only</span>
				</Show>
				<Show when={s().toolCount !== undefined}>
					<span class="tool-collapsed-note">{s().toolCount} tools</span>
				</Show>
			</div>
			<div class="integrations-row-detail">
				<code class="integrations-target">{target()}</code>
				<Show when={(s().envKeys ?? []).length > 0}>
					<span class="tool-collapsed-note"> · env: {(s().envKeys ?? []).join(", ")}</span>
				</Show>
				<Show when={(s().headerNames ?? []).length > 0}>
					<span class="tool-collapsed-note"> · headers: {(s().headerNames ?? []).join(", ")}</span>
				</Show>
				<Show when={s().auth === "oauth"}>
					<span class="tool-collapsed-note"> · OAuth</span>
				</Show>
			</div>
			<Show when={s().error}>
				{(msg) => (
					<div class="msg-notice" role="alert">
						{msg()}
					</div>
				)}
			</Show>
			<div class="integrations-row-actions">
				<button type="button" class="settings-control-btn" onClick={() => testMcpServer(s().name)}>
					Test
				</button>
				<button type="button" class="settings-control-btn" onClick={() => inspectMcp(s().name)}>
					Inspect
				</button>
				<Show when={s().enabled}>
					<button
						type="button"
						class="settings-control-btn"
						onClick={() => reconnectMcpServer(s().name)}
					>
						Reconnect
					</button>
				</Show>
				<button type="button" class="settings-control-btn" onClick={toggle}>
					{s().enabled ? "Disable" : "Enable"}
				</button>
				<Show when={writableScope()}>
					{(scope) => (
						<>
							<button type="button" class="settings-control-btn" onClick={() => props.onEdit(s())}>
								Edit
							</button>
							<button
								type="button"
								class="settings-control-btn settings-control-btn-danger"
								onClick={() => removeMcpServer(s().name, scope())}
							>
								Remove
							</button>
						</>
					)}
				</Show>
				<Show when={s().auth === "oauth"}>
					<button
						type="button"
						class="settings-control-btn"
						onClick={() => revokeMcpOAuth(s().name)}
					>
						Revoke OAuth
					</button>
				</Show>
			</div>
			<Show when={s().scope === "discovered"}>
				<p class="integrations-hint">
					Declared by {s().source ?? "another tool"}. Change it in that tool's config; omp cannot
					edit it.
				</p>
			</Show>
			<Show when={testResult()}>
				{(result) => (
					<div class="integrations-result" role="status">
						<div>
							<strong>{result().ok ? "Connected" : "Test failed"}</strong> {result().detail}
						</div>
						<Show when={result().tools.length > 0}>
							<ul class="integrations-chips" aria-label={`${s().name} tools`}>
								<For each={result().tools}>{(tool) => <li>{tool}</li>}</For>
							</ul>
						</Show>
					</div>
				)}
			</Show>
			<Show when={inspection()}>
				{(found) => (
					<div class="integrations-result" role="status">
						<div>
							{found().tools.length} tools · {found().resources.length} resources ·{" "}
							{found().prompts.length} prompts
						</div>
						<Show when={found().tools.length > 0}>
							<ul class="integrations-chips" aria-label={`${s().name} tool details`}>
								<For each={found().tools}>
									{(tool) => <li title={tool.description ?? ""}>{tool.name}</li>}
								</For>
							</ul>
						</Show>
						<Show when={found().resources.length > 0}>
							<ul class="integrations-chips" aria-label={`${s().name} resources`}>
								<For each={found().resources}>{(res) => <li>{res.name ?? res.uri}</li>}</For>
							</ul>
						</Show>
						<Show when={found().prompts.length > 0}>
							<ul class="integrations-chips" aria-label={`${s().name} prompts`}>
								<For each={found().prompts}>{(prompt) => <li>{prompt.name}</li>}</For>
							</ul>
						</Show>
					</div>
				)}
			</Show>
			<Show when={mcpInspecting() && inspection() === null}>
				<div class="tool-collapsed-note">Inspecting…</div>
			</Show>
		</li>
	);
};
