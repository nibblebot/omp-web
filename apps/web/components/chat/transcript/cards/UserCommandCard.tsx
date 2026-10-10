import type { Component } from "solid-js";
import { call, type ChatItem } from "../../../../state";
import { Card } from "../../../ui/Card";

/**
 * The user's own `!` / `!!` shell command or `$` / `$$` python prompt input:
 * prompt line, running/abort or exit status, output, truncation note. Distinct
 * from the model's bash tool call, which renders through BashToolCard.
 */
export const UserCommandCard: Component<{ item: Extract<ChatItem, { kind: "bash" }> }> = (
	props,
) => {
	const bash = () => props.item;
	return (
		<Card
			class="user-command-card"
			classList={{ dimmed: bash().dimmed }}
			header={
				<>
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
								class="user-command-abort"
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
				</>
			}
		>
			{bash().output && <pre>{bash().output}</pre>}
			{bash().truncated && <div class="user-command-truncated">(truncated)</div>}
		</Card>
	);
};
