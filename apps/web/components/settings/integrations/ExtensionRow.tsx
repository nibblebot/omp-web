import { Show, type Component } from "solid-js";
import type { McpConnectionState } from "#lib/wire/protocol";
import { mcpStatusLabel } from "../../../store/integrations";
import { SettingToggle } from "../controls/SettingToggle";

/** One skill or MCP server in its tab's list: select it for detail, switch it on or off in place. */
export const ExtensionRow: Component<{
	name: string;
	source: string;
	/** Small badge after the source (a skill hidden from the agent's listing). */
	badge?: string;
	/** MCP connection state: shown as a dot and label. */
	status?: McpConnectionState;
	enabled: boolean;
	selected: boolean;
	/** A write is in flight; the switch waits for it. */
	busy: boolean;
	onSelect: () => void;
	onToggle: (enabled: boolean) => void;
}> = (props) => (
	<li
		class="extension-row"
		classList={{ "extension-row-selected": props.selected }}
		data-enabled={props.enabled ? "true" : "false"}
	>
		<button
			type="button"
			class="extension-row-main"
			aria-current={props.selected ? "true" : undefined}
			onClick={props.onSelect}
		>
			<span class="extension-row-name">{props.name}</span>
			<span class="extension-row-meta">
				<Show when={props.status}>
					{(status) => (
						<>
							<span class={`integrations-dot integrations-dot-${status()}`} aria-hidden="true" />
							<span>{mcpStatusLabel(status())}</span>
							<span aria-hidden="true">·</span>
						</>
					)}
				</Show>
				<span>{props.source}</span>
				<Show when={props.badge}>
					<span class="integrations-badge">{props.badge}</span>
				</Show>
			</span>
		</button>
		<SettingToggle
			label={props.name}
			checked={props.enabled}
			disabled={props.busy}
			onChange={props.onToggle}
		/>
	</li>
);
