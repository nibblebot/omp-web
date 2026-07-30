import { For, type Component } from "solid-js";
import { state, type ToolItem } from "../../state";

const GLYPH: Record<string, string> = { done: "☑", completed: "☑", in_progress: "◐", pending: "☐", abandoned: "⊘", blocked: "✗" };

interface TodoTask { content: string; status: string }
interface TodoPhaseShape { name: string; tasks: TodoTask[] }

function parsePhases(args: unknown): TodoPhaseShape[] {
	if (!args || typeof args !== "object") return [];
	const a = args as { phases?: unknown; items?: unknown; tasks?: unknown };
	if (Array.isArray(a.phases)) {
		return a.phases.flatMap(p => {
			if (p && typeof p === "object" && "name" in p && Array.isArray((p as { tasks: unknown }).tasks)) {
				const { name, tasks } = p as { name: string; tasks: TodoTask[] };
				return [{ name, tasks: tasks.filter(t => t && typeof t.content === "string" && typeof t.status === "string") }];
			}
			return [];
		});
	}
	if (Array.isArray(a.items)) {
		const tasks = (a.items as TodoTask[]).filter(t => t && typeof t.content === "string" && typeof t.status === "string");
		return [{ name: "Todos", tasks }];
	}
	return [];
}

/** Todo tool: live state.todoPhases when present, otherwise the tool's own args. */
export const TodoTool: Component<{ item: ToolItem }> = props => {
	const live = () => state.todoPhases;
	const fallback = () => parsePhases(props.item.args);
	const phases = () => (live().length > 0 ? live() : fallback());
	return (
		<div class="tool-card todo-tool">
			<div class="tool-header">
				<span class="tool-name">todos</span>
			</div>
			<div class="todo-body">
				<For each={phases()}>
					{phase => (
						<div class="todo-phase">
							<div class="todo-phase-name">{phase.name}</div>
							<For each={phase.tasks}>
								{task => (
									<div class="todo-item" data-status={task.status}>
										<span class="todo-glyph">{GLYPH[task.status] ?? "☐"}</span>
										<span class="todo-text">{task.content}</span>
									</div>
								)}
							</For>
						</div>
					)}
				</For>
				{phases().length === 0 && <div class="tool-collapsed-note">no todos</div>}
			</div>
		</div>
	);
};
