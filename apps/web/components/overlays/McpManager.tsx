import { createSignal, For, onMount, Show, type Component } from "solid-js";
import { state } from "../../state";
import { Modal } from "../shared/Modal";
import {
	addMcpServer,
	disableMcpServer,
	enableMcpServer,
	inspectMcp,
	mcpError,
	mcpInspecting,
	mcpInspection,
	mcpLoading,
	mcpServers,
	mcpTestResult,
	mcpUnavailable,
	reauthMcpServer,
	refreshMcp,
	reloadMcpServer,
	removeMcpServer,
	reconnectMcpServer,
	revokeMcpOAuth,
	testMcpServer,
	updateMcpServer,
} from "../../store/integrations";
export const McpManager: Component<{ onClose: () => void }> = (props) => {
	const [filter, setFilter] = createSignal("");
	const [name, setName] = createSignal("");
	const [transport, setTransport] = createSignal("stdio");
	const [endpoint, setEndpoint] = createSignal("");
	const [inspectKind, setInspectKind] = createSignal("resources");
	const [inspectTarget, setInspectTarget] = createSignal("");
	const [scope, setScope] = createSignal<"project" | "profile">("project");
	const [editing, setEditing] = createSignal<string | null>(null);
	const [argumentsText, setArgumentsText] = createSignal("");
	const [resourceTarget, setResourceTarget] = createSignal("");
	const [formError, setFormError] = createSignal<string | null>(null);

	onMount(() => {
		refreshMcp();
	});

	const visible = () => {
		const q = filter().toLowerCase();
		const list = mcpServers();
		return q
			? list.filter(
					(s) =>
						s.name.toLowerCase().includes(q) ||
						(s.transport ?? "").toLowerCase().includes(q) ||
						(s.status ?? "").toLowerCase().includes(q),
				)
			: list;
	};

	const submitAdd = () => {
		const trimmed = name().trim();
		if (trimmed === "") return;
		const ep = endpoint().trim();
		let args: string[];
		try {
			const parsed: unknown = JSON.parse(argumentsText() || "[]");
			if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === "string"))
				throw new Error("Command arguments must be a JSON array of strings.");
			args = parsed;
		} catch (error) {
			setFormError(String(error));
			return;
		}
		const config = {
			name: trimmed,
			transport: transport(),
			scope: scope(),
			args,
			...(transport() === "stdio" ? { command: ep } : { url: ep }),
		};
		const editedName = editing();
		if (editedName) updateMcpServer(editedName, config);
		else addMcpServer(config);
		setEditing(null);
		setFormError(null);
		setName("");
		setEndpoint("");
	};

	return (
		<Modal title="MCP servers" onClose={props.onClose}>
			<input
				class="picker-filter"
				aria-label="Filter MCP servers"
				placeholder="Filter by name, transport, or status…"
				value={filter()}
				onInput={(e) => setFilter(e.currentTarget.value)}
			/>
			<Show when={mcpUnavailable()}>{(msg) => <div class="msg-notice">{msg()}</div>}</Show>
			<Show when={mcpError()}>{(err) => <div class="msg-notice">{err()}</div>}</Show>
			<Show when={mcpLoading()}>
				<div class="tool-collapsed-note">Loading MCP servers…</div>
			</Show>
			<Show
				when={visible().length > 0}
				fallback={
					<Show when={!mcpLoading() && !mcpUnavailable()}>
						<div class="tool-collapsed-note">
							No MCP servers configured. Add one below or check the daemon config.
						</div>
					</Show>
				}
			>
				<div class="picker-list">
					<For each={visible()}>
						{(s) => (
							<div class="settings-row">
								<span class="picker-label">
									{s.name}
									<Show when={s.transport}>
										<span class="tool-collapsed-note"> · {s.transport}</span>
									</Show>
									<Show when={s.status}>
										<span class="tool-collapsed-note"> · {s.status}</span>
									</Show>
									<Show when={s.enabled === false}>
										<span class="tool-collapsed-note"> · disabled</span>
									</Show>
									<Show when={s.source}>
										<span class="tool-collapsed-note"> · {s.source}</span>
									</Show>
								</span>
								<Show when={s.error}>{(msg) => <div class="msg-notice">{msg()}</div>}</Show>
								<div>
									<button
										type="button"
										class="settings-control-btn"
										onClick={() => testMcpServer(s.name)}
									>
										test
									</button>
									<button
										type="button"
										class="settings-control-btn"
										onClick={() => reconnectMcpServer(s.name)}
									>
										reconnect
									</button>
									<button
										type="button"
										class="settings-control-btn"
										onClick={() => reloadMcpServer(s.name)}
									>
										reload
									</button>
									<Show
										when={s.enabled === false}
										fallback={
											<button
												type="button"
												class="settings-control-btn"
												onClick={() => disableMcpServer(s.name)}
											>
												disable
											</button>
										}
									>
										<button
											type="button"
											class="settings-control-btn"
											onClick={() => enableMcpServer(s.name)}
										>
											enable
										</button>
									</Show>
									<button
										type="button"
										class="settings-control-btn"
										onClick={() => reauthMcpServer(s.name)}
										title="Re-authenticate OAuth (opens the provider page in a new tab)"
									>
										reauth
									</button>
									<button
										type="button"
										class="settings-control-btn"
										onClick={() => revokeMcpOAuth(s.name)}
									>
										revoke
									</button>
									<button
										type="button"
										class="settings-control-btn"
										onClick={() => removeMcpServer(s.name)}
									>
										remove
									</button>
									<button
										type="button"
										class="settings-control-btn"
										onClick={() => {
											setEditing(s.name);
											setName(s.name);
											setTransport(s.transport ?? "stdio");
											setEndpoint("");
										}}
									>
										edit configuration
									</button>
								</div>
							</div>
						)}
					</For>
				</div>
			</Show>
			<Show when={mcpTestResult()}>
				{(r) => (
					<div class="msg-notice">
						test {r().server}: {r().text}
					</div>
				)}
			</Show>
			<div class="picker-group-name">{editing() ? `Update ${editing()}` : "Add server"}</div>
			<Show when={formError()}>
				{(message) => (
					<div role="alert" class="msg-notice">
						{message()}
					</div>
				)}
			</Show>
			<div class="settings-row">
				<input
					class="picker-filter"
					aria-label="Server name"
					placeholder="name"
					value={name()}
					onInput={(e) => setName(e.currentTarget.value)}
				/>
				<select
					aria-label="Transport"
					value={transport()}
					onChange={(e) => setTransport(e.currentTarget.value)}
				>
					<option value="stdio">stdio</option>
					<option value="sse">sse</option>
					<option value="http">http</option>
				</select>
				<input
					class="picker-filter"
					aria-label="URL or command"
					placeholder={editing() ? "New URL or command (required)" : "URL or command"}
					value={endpoint()}
					onInput={(e) => setEndpoint(e.currentTarget.value)}
				/>
				<input
					class="picker-filter"
					aria-label="Command arguments JSON"
					placeholder='Arguments JSON, e.g. ["--port","8080"]'
					value={argumentsText()}
					onInput={(e) => setArgumentsText(e.currentTarget.value)}
				/>
				<select
					aria-label="Configuration scope"
					value={scope()}
					onChange={(e) => setScope(e.currentTarget.value === "profile" ? "profile" : "project")}
				>
					<option value="project">Project</option>
					<option value="profile">Profile</option>
				</select>
				<button type="button" class="settings-control-btn" onClick={submitAdd}>
					{editing() ? "update" : "add"}
				</button>
			</div>
			<div class="picker-group-name">Inspect resources, prompts, notifications</div>
			<div class="settings-row">
				<select
					aria-label="Inspector kind"
					value={inspectKind()}
					onChange={(e) => setInspectKind(e.currentTarget.value)}
				>
					<option value="resources">resources</option>
					<option value="prompts">prompts</option>
					<option value="notifications">notifications</option>
				</select>
				<input
					class="picker-filter"
					aria-label="Inspector target"
					placeholder="server name (uses filter match when empty)"
					value={inspectTarget()}
					onInput={(e) => setInspectTarget(e.currentTarget.value)}
				/>
				<input
					class="picker-filter"
					aria-label="Resource URI or prompt name"
					placeholder="Optional resource URI or prompt name"
					value={resourceTarget()}
					onInput={(e) => setResourceTarget(e.currentTarget.value)}
				/>
				<button
					type="button"
					class="settings-control-btn"
					disabled={mcpInspecting()}
					onClick={() => {
						const target = inspectTarget().trim();
						const pick = target !== "" ? target : visible().length === 1 ? visible()[0].name : "";
						if (pick !== "") inspectMcp(pick, inspectKind(), resourceTarget().trim() || undefined);
					}}
				>
					inspect
				</button>
			</div>
			<Show when={mcpInspection()}>
				{(insp) => (
					<div>
						<div class="picker-group-name">
							{insp().kind} · {insp().server}
						</div>
						<pre class="msg-notice">{insp().text}</pre>
					</div>
				)}
			</Show>
			<Show when={state.authStatus === "signedOut"}>
				<div class="msg-notice">Signed out: MCP actions need a signed-in session.</div>
			</Show>
		</Modal>
	);
};
