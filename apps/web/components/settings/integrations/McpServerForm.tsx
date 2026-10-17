import { createSignal, Show, type Component } from "solid-js";
import type { McpTransport, McpScope } from "#lib/wire/protocol";
import { addMcpServer, updateMcpServer } from "../../../store/integrations";
import { buildMcpInput, type McpFormValues } from "./mcp-form";

/**
 * Add or edit an MCP server. Submitting only queues the trust review; the
 * write happens after the user confirms the dialog that lists what will run.
 */
export const McpServerForm: Component<{
	mode: "add" | "edit";
	initial: McpFormValues;
	onDone: () => void;
}> = (props) => {
	const [values, setValues] = createSignal<McpFormValues>({ ...props.initial });
	const [error, setError] = createSignal<string | null>(null);

	const set = <K extends keyof McpFormValues>(key: K, value: McpFormValues[K]) => {
		setValues({ ...values(), [key]: value });
	};

	const submit = (event: SubmitEvent) => {
		event.preventDefault();
		const result = buildMcpInput(values(), props.mode);
		if (!result.ok) {
			setError(result.error);
			return;
		}
		if (props.mode === "add") addMcpServer(result.input);
		else updateMcpServer(result.input);
		props.onDone();
	};

	return (
		<form
			class="integrations-form"
			onSubmit={submit}
			aria-label={props.mode === "add" ? "Add MCP server" : `Edit ${props.initial.name}`}
		>
			<div class="integrations-form-grid">
				<label class="integrations-field">
					<span>Name</span>
					<input
						value={values().name}
						disabled={props.mode === "edit"}
						required
						autocomplete="off"
						onInput={(e) => set("name", e.currentTarget.value)}
					/>
				</label>
				<label class="integrations-field">
					<span>Transport</span>
					<select
						value={values().transport}
						onChange={(e) => set("transport", e.currentTarget.value as McpTransport)}
					>
						<option value="stdio">stdio (local command)</option>
						<option value="http">http (remote URL)</option>
						<option value="sse">sse (remote URL)</option>
					</select>
				</label>
				<label class="integrations-field">
					<span>Scope</span>
					<select
						value={values().scope}
						onChange={(e) => set("scope", e.currentTarget.value as McpScope)}
					>
						<option value="user">User config</option>
						<option value="project">Project config</option>
					</select>
				</label>
			</div>
			<Show
				when={values().transport === "stdio"}
				fallback={
					<div class="integrations-form-grid">
						<label class="integrations-field integrations-field-wide">
							<span>URL</span>
							<input
								type="url"
								value={values().url}
								placeholder="https://example.com/mcp"
								autocomplete="off"
								onInput={(e) => set("url", e.currentTarget.value)}
							/>
						</label>
						<label class="integrations-field">
							<span>Headers, Name: value per line</span>
							<textarea
								rows="3"
								value={values().headersText}
								spellcheck={false}
								onInput={(e) => set("headersText", e.currentTarget.value)}
							/>
						</label>
						<label class="integrations-field">
							<span>Bearer token (optional)</span>
							<input
								type="password"
								value={values().token}
								autocomplete="new-password"
								onInput={(e) => set("token", e.currentTarget.value)}
							/>
						</label>
					</div>
				}
			>
				<div class="integrations-form-grid">
					<label class="integrations-field integrations-field-wide">
						<span>Command</span>
						<input
							value={values().command}
							placeholder="npx"
							autocomplete="off"
							spellcheck={false}
							onInput={(e) => set("command", e.currentTarget.value)}
						/>
					</label>
					<label class="integrations-field">
						<span>Arguments, one per line</span>
						<textarea
							rows="3"
							value={values().argsText}
							spellcheck={false}
							onInput={(e) => set("argsText", e.currentTarget.value)}
						/>
					</label>
					<label class="integrations-field">
						<span>Environment, KEY=value per line</span>
						<textarea
							rows="3"
							value={values().envText}
							spellcheck={false}
							onInput={(e) => set("envText", e.currentTarget.value)}
						/>
					</label>
				</div>
			</Show>
			<p class="integrations-hint">
				Values are sent to the agent and never shown back. A bare key line keeps the stored value
				when you save.
			</p>
			<Show when={error()}>
				{(msg) => (
					<div class="msg-notice" role="alert">
						{msg()}
					</div>
				)}
			</Show>
			<div class="integrations-form-actions">
				<button type="submit" class="settings-control-btn">
					{props.mode === "add" ? "Review and add" : "Review and save"}
				</button>
				<button type="button" class="settings-control-btn" onClick={() => props.onDone()}>
					Cancel
				</button>
			</div>
		</form>
	);
};
