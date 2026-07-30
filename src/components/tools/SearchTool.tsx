import { For, type Component } from "solid-js";
import type { ToolItem } from "../../state";

const MATCH_LINE = /^(.+?):(\d+):(.*)$/;

/** grep/glob: monospace result lines; path:line: prefixes copy to clipboard. */
export const SearchTool: Component<{ item: ToolItem }> = props => {
	const summary = () => {
		const args = props.item.args as { pattern?: string; query?: string; glob?: string } | null;
		return args?.pattern ?? args?.query ?? args?.glob ?? "";
	};
	const lines = () => props.item.output.split("\n").filter(l => l.length > 0);
	return (
		<div class="tool-card search-tool">
			<div class="tool-header">
				<span class="tool-name">
					{props.item.name} {summary()}
				</span>
				<span class="tool-status" data-status={props.item.status}>
					{props.item.status}
				</span>
			</div>
			<div class="search-body">
				<For each={lines()}>
					{line => {
						const m = MATCH_LINE.exec(line);
						if (!m) return <div class="search-line">{line}</div>;
						return (
							<div class="search-line">
								<button
									class="search-path"
									title="Copy path"
									onClick={() => void navigator.clipboard.writeText(m[1]).catch(() => {})}
								>
									{m[1]}:{m[2]}
								</button>
								{m[3]}
							</div>
						);
					}}
				</For>
			</div>
		</div>
	);
};
