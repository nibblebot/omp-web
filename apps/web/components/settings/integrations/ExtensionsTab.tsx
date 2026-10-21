import { createSignal, For, onMount, Show, type Component } from "solid-js";
import type { McpServerSummary } from "#lib/wire/protocol";
import {
	extensionBusy,
	extensionsDrill,
	extensionsQuery,
	extensionsSelected,
	leaveExtensionDetail,
	mcpError,
	mcpLoading,
	mcpPaths,
	mcpProjectConfigEnabled,
	mcpServers,
	mcpSourceLabel,
	refreshMcp,
	refreshSkills,
	searchAutofocus,
	selectedMcpServer,
	selectedSkill,
	selectExtension,
	setExtensionsQuery,
	setMcpServerEnabled,
	setSkillEnabled,
	showExtensionDetail,
	skills,
	skillsError,
	skillsLoading,
	skillWarnings,
	visibleMcpServers,
	visibleSkills,
} from "../../../store/integrations";
import { ExtensionRow } from "./ExtensionRow";
import { McpServerDetailPanel } from "./McpServerDetailPanel";
import { McpServerForm } from "./McpServerForm";
import { SkillDetailPanel } from "./SkillDetailPanel";
import { EMPTY_MCP_FORM, formFromServer, type McpFormValues } from "./mcp-form";

interface FormState {
	mode: "add" | "edit";
	initial: McpFormValues;
}

/**
 * Skills and MCP servers in one searchable list with the selected one's detail beside it.
 * In a narrow container the detail replaces the list, with Back.
 */
export const ExtensionsTab: Component = () => {
	let search!: HTMLInputElement;
	const [form, setForm] = createSignal<FormState | null>(null);

	onMount(() => {
		refreshSkills();
		refreshMcp();
		if (searchAutofocus()) search.focus();
	});

	const searching = () => extensionsQuery().trim() !== "";
	const nothingMatches = () =>
		searching() && visibleSkills().length === 0 && visibleMcpServers().length === 0;

	const select = (kind: "skill" | "mcp", name: string) => {
		setForm(null);
		selectExtension({ kind, name });
	};
	const openAdd = () => {
		setForm({ mode: "add", initial: { ...EMPTY_MCP_FORM } });
		showExtensionDetail();
	};
	const openEdit = (server: McpServerSummary) => {
		setForm({ mode: "edit", initial: formFromServer(server) });
		showExtensionDetail();
	};
	const back = () => {
		setForm(null);
		leaveExtensionDetail();
	};

	return (
		<div class="integrations-tab extensions-tab">
			<div class="extensions-layout" data-view={extensionsDrill() ? "detail" : "list"}>
				<div class="extensions-list-pane">
					<input
						ref={search}
						class="picker-filter"
						type="search"
						aria-label="Search extensions"
						placeholder="Search skills and MCP servers"
						value={extensionsQuery()}
						onInput={(e) => setExtensionsQuery(e.currentTarget.value)}
					/>
					<Show when={skillsError()}>
						{(msg) => (
							<div class="msg-notice" role="alert">
								{msg()}
							</div>
						)}
					</Show>
					<Show when={mcpError()}>
						{(msg) => (
							<div class="msg-notice" role="alert">
								{msg()}
							</div>
						)}
					</Show>
					<For each={skillWarnings()}>{(warning) => <div class="msg-notice">{warning}</div>}</For>
					<Show when={!searching() || visibleSkills().length > 0}>
						<section class="extensions-group" aria-labelledby="extensions-skills-heading">
							<div class="extensions-group-head">
								<h3 class="extensions-group-title" id="extensions-skills-heading">
									Skills ({visibleSkills().length})
								</h3>
							</div>
							<Show when={skillsLoading() && skills().length === 0}>
								<div class="tool-collapsed-note">Loading skills…</div>
							</Show>
							<Show when={visibleSkills().length > 0}>
								<ul class="extensions-list" aria-label="Skills">
									<For each={visibleSkills()}>
										{(skill) => (
											<ExtensionRow
												name={skill.name}
												source={skill.source}
												badge={skill.hidden ? "hidden" : undefined}
												enabled={skill.enabled}
												selected={
													extensionsSelected()?.kind === "skill" &&
													extensionsSelected()?.name === skill.name
												}
												busy={extensionBusy("skill", skill.name)}
												onSelect={() => select("skill", skill.name)}
												onToggle={(enabled) => setSkillEnabled(skill.name, enabled)}
											/>
										)}
									</For>
								</ul>
							</Show>
							<Show when={!skillsLoading() && skills().length === 0}>
								<div class="tool-collapsed-note">
									No skills found in the skill folders the agent scans. Install skills from a
									terminal with <code>omp skill install &lt;spec&gt;</code>.
								</div>
							</Show>
						</section>
					</Show>
					<Show when={!searching() || visibleMcpServers().length > 0}>
						<section class="extensions-group" aria-labelledby="extensions-mcp-heading">
							<div class="extensions-group-head">
								<h3 class="extensions-group-title" id="extensions-mcp-heading">
									MCP servers ({visibleMcpServers().length})
								</h3>
								<button type="button" class="settings-control-btn" onClick={openAdd}>
									Add server
								</button>
							</div>
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
												onSelect={() => select("mcp", server.name)}
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
						</section>
					</Show>
					<Show when={nothingMatches()}>
						<div class="tool-collapsed-note">Nothing matches the search.</div>
					</Show>
				</div>
				<div class="extensions-detail-pane">
					<button type="button" class="settings-control-btn extensions-back" onClick={back}>
						Back
					</button>
					<Show
						when={form()}
						keyed
						fallback={
							<Show
								when={selectedSkill()}
								fallback={
									<Show
										when={selectedMcpServer()}
										fallback={
											<div class="tool-collapsed-note">
												Select a skill or an MCP server to see its details.
											</div>
										}
									>
										{(server) => <McpServerDetailPanel server={server()} onEdit={openEdit} />}
									</Show>
								}
							>
								{(skill) => <SkillDetailPanel skill={skill()} />}
							</Show>
						}
					>
						{(state) => (
							<McpServerForm
								mode={state.mode}
								initial={state.initial}
								onDone={() => setForm(null)}
							/>
						)}
					</Show>
				</div>
			</div>
		</div>
	);
};
