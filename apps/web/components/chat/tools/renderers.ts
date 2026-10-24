import type { Component } from "solid-js";
import type { ToolItem } from "../../../state";
import { AskToolCard } from "./AskToolCard";
import { BashToolCard } from "./BashToolCard";
import { DiffToolCard } from "./DiffToolCard";
import { EvalToolCard } from "./EvalToolCard";
import { LspToolCard } from "./LspToolCard";
import { ReadToolCard } from "./ReadToolCard";
import { SearchToolCard } from "./SearchToolCard";
import { TaskToolCard } from "./TaskToolCard";
import { TodoToolCard } from "./TodoToolCard";
import { WaitToolCard } from "./WaitToolCard";
import { WebSearchToolCard } from "./WebSearchToolCard";

/** Per-tool renderers; anything missing falls back to GenericToolCard. */
export const RENDERERS: Record<string, Component<{ item: ToolItem }>> = {
	bash: BashToolCard,
	edit: DiffToolCard,
	write: DiffToolCard,
	apply_patch: DiffToolCard,
	read: ReadToolCard,
	todo: TodoToolCard,
	grep: SearchToolCard,
	glob: SearchToolCard,
	web_search: WebSearchToolCard,
	task: TaskToolCard,
	eval: EvalToolCard,
	lsp: LspToolCard,
	wait: WaitToolCard,
	ask: AskToolCard,
};
