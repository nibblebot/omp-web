import { createSignal, For, onMount, Show, type Component } from "solid-js";
import type { McpServerSummary } from "#lib/wire/protocol";
import {
	mcpError,
	mcpLoading,
	mcpPaths,
	mcpProjectConfigEnabled,
	mcpServers,
	refreshMcp,
} from "../../../store/integrations";
import { McpServerForm } from "./McpServerForm";
import { McpServerRow } from "./McpServerRow";
import { EMPTY_MCP_FORM, formFromServer, type McpFormValues } from "./mcp-form";

interface FormState {
	mode: "add" | "edit";
	initial: McpFormValues;
}

export const McpTab: Component = () => {
	const [filter, setFilter] = createSignal("");
	const [form, setForm] = createSignal<FormState | null>(null);

	onMount(() => refreshMcp());

	const visible = () => {
		const query = filter().trim().toLowerCase();
		if (query === "") return mcpServers();
		return mcpServers().filter((server) =>
			`${server.name} ${server.transport} ${server.status} ${server.scope}`
				.toLowerCase()
				.includes(query),
		);
	};

	const openAdd = () => setForm({ mode: "add", initial: { ...EMPTY_MCP_FORM } });
	const openEdit = (server: McpServerSummary) =>
		setForm({ mode: "edit", initial: formFromServer(server) });

	return (
		<div class="integrations-tab integrations-mcp">
			<div class="integrations-toolbar">
				<input
					class="picker-filter"
					type="search"
					aria-label="Filter MCP servers"
					placeholder="Filter by name, transport, or status"
					value={filter()}
					onInput={(e) => setFilter(e.currentTarget.value)}
				/>
				<button type="button" class="settings-control-btn" onClick={openAdd}>
					Add server
				</button>
			</div>
			<Show when={mcpPaths()}>
				{(paths) => (
					<p class="integrations-hint">
						User config <code>{paths().user}</code>. Project config <code>{paths().project}</code>
						{mcpProjectConfigEnabled() ? "" : ". Project servers are off (mcp.enableProjectConfig)"}
						.
					</p>
				)}
			</Show>
			<Show when={mcpError()}>
				{(msg) => (
					<div class="msg-notice" role="alert">
						{msg()}
					</div>
				)}
			</Show>
			<Show when={form()}>
				{(state) => (
					<McpServerForm
						mode={state().mode}
						initial={state().initial}
						onDone={() => setForm(null)}
					/>
				)}
			</Show>
			<Show when={mcpLoading()}>
				<div class="tool-collapsed-note">Loading MCP servers…</div>
			</Show>
			<Show when={visible().length > 0}>
				<ul class="integrations-list" aria-label="MCP servers">
					<For each={visible()}>
						{(server) => <McpServerRow server={server} onEdit={openEdit} />}
					</For>
				</ul>
			</Show>
			<Show when={!mcpLoading() && visible().length === 0}>
				<div class="tool-collapsed-note">
					{mcpServers().length === 0
						? "No MCP servers configured. Add one to give the agent its tools."
						: "No servers match the filter."}
				</div>
			</Show>
		</div>
	);
};
