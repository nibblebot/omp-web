import type { Component } from "solid-js";
import type { ToolItem } from "../../../state";
import { AskToolCard } from "./AskToolCard";
import { BashToolCard } from "./BashToolCard";
import { DiffToolCard } from "./DiffToolCard";
import { EvalToolCard } from "./EvalToolCard";
import { GithubToolCard } from "./GithubToolCard";
import { LazyFindToolCard } from "./LazyFindToolCard";
import { LspToolCard } from "./LspToolCard";
import { ReadToolCard } from "./ReadToolCard";
import { SearchToolCard } from "./SearchToolCard";
import { TaskToolCard } from "./TaskToolCard";
import { TodoToolCard } from "./TodoToolCard";
import { WebSearchToolCard } from "./WebSearchToolCard";

/** Per-tool renderers; anything missing falls back to GenericToolCard. `wait` is not here: consecutive waits fold into one `WaitToolCard` that TranscriptStream renders itself. */
export const RENDERERS: Record<string, Component<{ item: ToolItem }>> = {
	bash: BashToolCard,
	edit: DiffToolCard,
	write: DiffToolCard,
	apply_patch: DiffToolCard,
	read: ReadToolCard,
	todo: TodoToolCard,
	grep: SearchToolCard,
	glob: SearchToolCard,
	find: LazyFindToolCard,
	web_search: WebSearchToolCard,
	task: TaskToolCard,
	eval: EvalToolCard,
	lsp: LspToolCard,
	github: GithubToolCard,
	ask: AskToolCard,
};
