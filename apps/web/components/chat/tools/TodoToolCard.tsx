import { For, type Component } from "solid-js";
import { Dynamic } from "solid-js/web";
import {
	BanIcon,
	LoaderIcon,
	SquareCheckIcon,
	SquareIcon,
	XIcon,
	type IconProps,
} from "../../ui/icons";
import type { ToolItem } from "../../../state";
import { ToolCardShell } from "./ToolCardShell";

const TODO_ICON: Record<string, Component<IconProps>> = {
	done: SquareCheckIcon,
	completed: SquareCheckIcon,
	in_progress: LoaderIcon,
	pending: SquareIcon,
	abandoned: BanIcon,
	blocked: XIcon,
};

interface TodoTask {
	content: string;
	status: string;
}
interface TodoPhaseShape {
	name: string;
	tasks: TodoTask[];
}

function parsePhases(args: unknown): TodoPhaseShape[] {
	if (!args || typeof args !== "object") return [];
	const a = args as { phases?: unknown; items?: unknown; tasks?: unknown };
	if (Array.isArray(a.phases)) {
		return a.phases.flatMap((p) => {
			if (
				p &&
				typeof p === "object" &&
				"name" in p &&
				Array.isArray((p as { tasks: unknown }).tasks)
			) {
				const { name, tasks } = p as { name: string; tasks: TodoTask[] };
				return [
					{
						name,
						tasks: tasks.filter(
							(t) => t && typeof t.content === "string" && typeof t.status === "string",
						),
					},
				];
			}
			return [];
		});
	}
	if (Array.isArray(a.items)) {
		const tasks = (a.items as TodoTask[]).filter(
			(t) => t && typeof t.content === "string" && typeof t.status === "string",
		);
		return [{ name: "Todos", tasks }];
	}
	return [];
}

/** Todo tool: the phases this call settled with (its result details), else its own args. Never the live list (REV-06). */
export const TodoToolCard: Component<{ item: ToolItem }> = (props) => {
	const snapshot = () => parsePhases(props.item.details);
	const fallback = () => parsePhases(props.item.args);
	const phases = () => (snapshot().length > 0 ? snapshot() : fallback());
	return (
		<ToolCardShell name="todos" class="todo-tool">
			<div class="todo-body">
				<For each={phases()}>
					{(phase) => (
						<div class="todo-phase">
							<div class="todo-phase-name">{phase.name}</div>
							<For each={phase.tasks}>
								{(task) => (
									<div class="todo-item" data-status={task.status}>
										<span class="todo-glyph">
											<Dynamic component={TODO_ICON[task.status] ?? SquareIcon} />
										</span>
										<span class="todo-text">{task.content}</span>
									</div>
								)}
							</For>
						</div>
					)}
				</For>
				{phases().length === 0 && <div class="tool-collapsed-note">no todos</div>}
			</div>
		</ToolCardShell>
	);
};
