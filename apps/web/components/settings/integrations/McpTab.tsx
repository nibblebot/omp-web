import { createSignal, For, onMount, Show, type Component } from "solid-js";
import type { McpServerSummary } from "#lib/wire/protocol";
import {
	extensionBusy,
	extensionsSelected,
	mcpError,
	mcpLoading,
	mcpPaths,
	mcpProjectConfigEnabled,
	mcpServers,
	mcpSourceLabel,
	refreshMcp,
	selectedMcpServer,
	selectExtension,
	setMcpServerEnabled,
	showExtensionDetail,
	visibleMcpServers,
} from "../../../store/integrations";
import { ExtensionRow } from "./ExtensionRow";
import { ExtensionsLayout } from "./ExtensionsLayout";
import { McpServerDetailPanel } from "./McpServerDetailPanel";
import { McpServerForm } from "./McpServerForm";
import { EMPTY_MCP_FORM, formFromServer, type McpFormValues } from "./mcp-form";

interface FormState {
	mode: "add" | "edit";
	initial: McpFormValues;
}

/**
 * MCP servers, searchable, with a switch per row and the selected one's detail beside the list.
 * Add server and Edit put the server form where the detail goes.
 */
export const McpTab: Component = () => {
	const [form, setForm] = createSignal<FormState | null>(null);
	onMount(refreshMcp);

	const select = (name: string) => {
		setForm(null);
		selectExtension({ kind: "mcp", name });
	};
	const openAdd = () => {
		setForm({ mode: "add", initial: { ...EMPTY_MCP_FORM } });
		showExtensionDetail();
	};
	const openEdit = (server: McpServerSummary) => {
		setForm({ mode: "edit", initial: formFromServer(server) });
		showExtensionDetail();
	};

	return (
		<ExtensionsLayout
			search="Search MCP servers"
			actions={
				<button type="button" class="settings-control-btn" onClick={openAdd}>
					Add server
				</button>
			}
			onBack={() => setForm(null)}
			list={
				<>
					<Show when={mcpError()}>
						{(msg) => (
							<div class="msg-notice" role="alert">
								{msg()}
							</div>
						)}
					</Show>
					<Show when={mcpPaths()}>
						{(paths) => (
							<p class="integrations-hint">
								User config <code>{paths().user}</code>. Project config{" "}
								<code>{paths().project}</code>
								{mcpProjectConfigEnabled()
									? ""
									: ". Project servers are off (mcp.enableProjectConfig)"}
								.
							</p>
						)}
					</Show>
					<Show when={mcpLoading() && mcpServers().length === 0}>
						<div class="tool-collapsed-note">Loading MCP servers…</div>
					</Show>
					<Show when={visibleMcpServers().length > 0}>
						<ul class="extensions-list" aria-label="MCP servers">
							<For each={visibleMcpServers()}>
								{(server) => (
									<ExtensionRow
										name={server.name}
										source={mcpSourceLabel(server)}
										status={server.status}
										enabled={server.enabled}
										selected={
											extensionsSelected()?.kind === "mcp" &&
											extensionsSelected()?.name === server.name
										}
										busy={extensionBusy("mcp", server.name)}
										onSelect={() => select(server.name)}
										onToggle={(enabled) => setMcpServerEnabled(server.name, enabled)}
									/>
								)}
							</For>
						</ul>
					</Show>
					<Show when={!mcpLoading() && mcpServers().length === 0}>
						<div class="tool-collapsed-note">
							No MCP servers configured. Add one to give the agent its tools.
						</div>
					</Show>
					<Show when={mcpServers().length > 0 && visibleMcpServers().length === 0}>
						<div class="tool-collapsed-note">Nothing matches the search.</div>
					</Show>
				</>
			}
			detail={
				<Show
					when={form()}
					keyed
					fallback={
						<Show
							when={selectedMcpServer()}
							fallback={
								<div class="tool-collapsed-note">Select an MCP server to see its details.</div>
							}
						>
							{(server) => <McpServerDetailPanel server={server()} onEdit={openEdit} />}
						</Show>
					}
				>
					{(state) => (
						<McpServerForm mode={state.mode} initial={state.initial} onDone={() => setForm(null)} />
					)}
				</Show>
			}
		/>
	);
};
