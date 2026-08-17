import type { Component } from "solid-js";
import { call, type ChatItem } from "../../../state";

/** Terminal card: prompt line, running/exit status, output, truncation note. */
export const BashCard: Component<{ item: Extract<ChatItem, { kind: "bash" }> }> = (props) => {
	const bash = () => props.item;
	return (
		<div class="bash-card" classList={{ dimmed: bash().dimmed }}>
			<div class="bash-header">
				<span class="bash-cmd">
					{bash().lang === "python" ? ">>> " : "$ "}
					{bash().command}
				</span>
				{bash().status === "running" ? (
					<>
						<span class="tool-status" data-status="running">
							running
						</span>
						<button
							class="bash-abort"
							onClick={() =>
								void call(bash().lang === "python" ? "abortEval" : "abortBash").catch(() => {})
							}
						>
							abort
						</button>
					</>
				) : (
					<span class="exit-badge" classList={{ nonzero: bash().exitCode !== 0 }}>
						{bash().exitCode ?? "err"}
					</span>
				)}
			</div>
			{bash().output && <pre>{bash().output}</pre>}
			{bash().truncated && <div class="bash-truncated">(truncated)</div>}
		</div>
	);
};
