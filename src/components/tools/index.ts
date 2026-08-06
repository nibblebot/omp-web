import type { Component } from "solid-js";
import type { ToolItem } from "../../state";
import { AskTool } from "./AskTool";
import { BashTool } from "./BashTool";
import { DiffTool } from "./DiffTool";
import { EvalTool } from "./EvalTool";
import { HubTool } from "./HubTool";
import { LspTool } from "./LspTool";
import { ReadTool } from "./ReadTool";
import { SearchTool } from "./SearchTool";
import { TaskTool } from "./TaskTool";
import { TodoTool } from "./TodoTool";
import { WebSearchTool } from "./WebSearchTool";

/** Per-tool renderers; anything missing falls back to GenericToolCard. */
export const RENDERERS: Record<string, Component<{ item: ToolItem }>> = {
	bash: BashTool,
	edit: DiffTool,
	write: DiffTool,
	apply_patch: DiffTool,
	read: ReadTool,
	todo: TodoTool,
	grep: SearchTool,
	glob: SearchTool,
	web_search: WebSearchTool,
	task: TaskTool,
	eval: EvalTool,
	lsp: LspTool,
	hub: HubTool,
	ask: AskTool,
};
