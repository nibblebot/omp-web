import { createEffect, createSignal, For, on, Show, type Component } from "solid-js";
import type { McpScope, McpServerSummary, McpToolParameter } from "#lib/wire/protocol";
import {
	extensionBusy,
	mcpInspectError,
	mcpInspecting,
	mcpInspection,
	mcpSourceLabel,
	mcpStatusLabel,
	mcpTestResult,
	reconnectMcpServer,
	removeMcpServer,
	revokeMcpOAuth,
	setMcpServerEnabled,
	testMcpServer,
} from "../../../store/integrations";
import { SettingToggle } from "../controls/SettingToggle";

/** Tools listed before "Show all". */
const TOOLS_SHOWN = 10;

const ToolParameters: Component<{ parameters: McpToolParameter[] }> = (props) => (
	<ul class="extension-params" aria-label="Parameters">
		<For each={props.parameters}>
			{(param) => (
				<li>
					<code>{param.name}</code>
					<span class="integrations-hint">
						{[param.type, param.required ? "required" : "optional"].filter(Boolean).join(", ")}
					</span>
					<Show when={param.description}>
						<span class="integrations-hint"> {param.description}</span>
					</Show>
				</li>
			)}
		</For>
	</ul>
);

/** One MCP server in full: switch, where it is configured and what runs, its tools, and its actions. */
export const McpServerDetailPanel: Component<{
	server: McpServerSummary;
	onEdit: (server: McpServerSummary) => void;
}> = (props) => {
	const s = () => props.server;
	const [showAllTools, setShowAllTools] = createSignal(false);
	createEffect(
		on(
			() => s().name,
			() => setShowAllTools(false),
			{ defer: true },
		),
	);

	/** The scope a remove or edit can target; null for servers declared by a third-party config. */
	const writableScope = (): McpScope | null => {
		const scope = s().scope;
		return s().writable && scope !== "discovered" ? scope : null;
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
	const inspectError = () => {
		const result = mcpInspectError();
		return result && result.server === s().name ? result.message : null;
	};
	const inspecting = () => mcpInspecting() === s().name;
	const tools = () => inspection()?.tools ?? [];
	const shownTools = () => (showAllTools() ? tools() : tools().slice(0, TOOLS_SHOWN));

	return (
		<article class="extension-detail" aria-label={`${s().name} MCP server`}>
			<header class="extension-detail-head">
				<h3 class="extension-detail-title">{s().name}</h3>
				<SettingToggle
					label={s().name}
					checked={s().enabled}
					disabled={extensionBusy("mcp", s().name)}
					onChange={(enabled) => setMcpServerEnabled(s().name, enabled)}
				/>
			</header>
			<p class="integrations-hint">
				<span class={`integrations-dot integrations-dot-${s().status}`} aria-hidden="true" />{" "}
				{mcpStatusLabel(s().status)}
				<Show when={s().toolCount !== undefined}> · {s().toolCount} tools</Show>
			</p>
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
				<Show when={s().enabled}>
					<button
						type="button"
						class="settings-control-btn"
						onClick={() => reconnectMcpServer(s().name)}
					>
						Reconnect
					</button>
				</Show>
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
			<dl class="extension-facts">
				<dt>Scope</dt>
				<dd>{mcpSourceLabel(s())}</dd>
				<Show when={s().toggleFile}>
					<dt>Switch writes</dt>
					<dd>
						<code class="integrations-target">{s().toggleFile}</code>
					</dd>
				</Show>
				<dt>Transport</dt>
				<dd>{s().transport}</dd>
				<Show when={inspection()?.server}>
					{(info) => (
						<>
							<dt>Server</dt>
							<dd>
								{info().name}
								<Show when={info().version}> {info().version}</Show>
							</dd>
						</>
					)}
				</Show>
				<dt>{s().transport === "stdio" ? "Command" : "URL"}</dt>
				<dd>
					<code class="integrations-target">{target()}</code>
				</dd>
				<dt>Auth</dt>
				<dd>{s().auth === "oauth" ? "OAuth" : s().auth === "token" ? "Token" : "None"}</dd>
				<Show when={(s().envKeys ?? []).length > 0}>
					<dt>Environment</dt>
					<dd>{(s().envKeys ?? []).join(", ")}</dd>
				</Show>
				<Show when={(s().headerNames ?? []).length > 0}>
					<dt>Headers</dt>
					<dd>{(s().headerNames ?? []).join(", ")}</dd>
				</Show>
			</dl>
			<Show
				when={s().enabled}
				fallback={<p class="integrations-hint">Turn the server on to list its tools.</p>}
			>
				<Show when={inspectError()}>
					{(message) => (
						<div class="msg-notice" role="alert">
							{message()}
						</div>
					)}
				</Show>
				<Show when={inspecting() && inspection() === null}>
					<div class="tool-collapsed-note">Loading tools…</div>
				</Show>
				<Show when={inspection()}>
					{(found) => (
						<>
							<section class="extension-section" aria-label="Tools">
								<h4 class="extension-section-title">Tools ({found().tools.length})</h4>
								<ul class="extension-tools">
									<For each={shownTools()}>
										{(tool) => (
											<li>
												<strong>{tool.title ?? tool.name}</strong>
												<Show when={tool.title && tool.title !== tool.name}>
													<code class="integrations-hint">{tool.name}</code>
												</Show>
												<Show when={tool.description}>
													<p class="integrations-hint">{tool.description}</p>
												</Show>
												<Show when={(tool.parameters ?? []).length > 0}>
													<ToolParameters parameters={tool.parameters ?? []} />
												</Show>
											</li>
										)}
									</For>
								</ul>
								<Show when={!showAllTools() && found().tools.length > TOOLS_SHOWN}>
									<button
										type="button"
										class="settings-control-btn"
										onClick={() => setShowAllTools(true)}
									>
										Show all {found().tools.length} tools
									</button>
								</Show>
							</section>
							<Show when={found().resources.length > 0}>
								<section class="extension-section" aria-label="Resources">
									<h4 class="extension-section-title">Resources ({found().resources.length})</h4>
									<ul class="extension-tools">
										<For each={found().resources}>
											{(res) => (
												<li>
													<strong>{res.name ?? res.uri}</strong>
													<Show when={res.name}>
														<code class="integrations-hint">{res.uri}</code>
													</Show>
													<Show when={res.description}>
														<p class="integrations-hint">{res.description}</p>
													</Show>
												</li>
											)}
										</For>
									</ul>
								</section>
							</Show>
							<Show when={found().prompts.length > 0}>
								<section class="extension-section" aria-label="Prompts">
									<h4 class="extension-section-title">Prompts ({found().prompts.length})</h4>
									<ul class="extension-tools">
										<For each={found().prompts}>
											{(prompt) => (
												<li>
													<strong>{prompt.name}</strong>
													<Show when={prompt.description}>
														<p class="integrations-hint">{prompt.description}</p>
													</Show>
												</li>
											)}
										</For>
									</ul>
								</section>
							</Show>
						</>
					)}
				</Show>
			</Show>
		</article>
	);
};
