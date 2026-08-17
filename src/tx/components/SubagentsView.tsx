import { For, Show, createResource } from "solid-js";
import { api } from "../api";
import { formatBytes, timeAgo } from "../util/format";

interface SubagentsProps {
	file: string;
	/** Open a subagent file's transcript in the same Transcript view. */
	onOpen: (file: string) => void;
}

export function SubagentsView(props: SubagentsProps) {
	const [subs] = createResource(
		() => props.file,
		(f) => api.subagents(f),
	);

	return (
		<div class="subagents">
			<Show
				when={subs.error}
				fallback={
					<Show when={subs()} fallback={<div class="hint">Loading subagents…</div>}>
						{(list) => (
							<Show
								when={list().length > 0}
								fallback={<div class="hint">No subagent transcripts for this session.</div>}
							>
								<div class="tx-subagent-list">
									<For each={list()}>
										{(s) => (
											<button
												type="button"
												class="tx-subagent-row"
												onClick={() => props.onOpen(s.file)}
												title={s.file}
											>
												<span class="subagent-name">{s.name}</span>
												<span class="subagent-size">{formatBytes(s.size)}</span>
												<span class="tx-subagent-time">{timeAgo(s.mtimeMs)}</span>
											</button>
										)}
									</For>
								</div>
							</Show>
						)}
					</Show>
				}
			>
				{(e) => <div class="tx-error-banner">Failed to load subagents: {e().message}</div>}
			</Show>
		</div>
	);
}
