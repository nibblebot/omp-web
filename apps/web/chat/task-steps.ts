/** One spawn of a `task` call that carries ordered `steps` (SDK 18.19.0 `task.steps`) in place of one `task` text. */
export interface TaskSpawnSteps {
	/** Zero-based position of the spawn in the call's `tasks[]`; 0 for a single spawn. */
	index: number;
	/** Batch calls only: the item's `name`, else "Task N". A single spawn has no label. */
	label?: string;
	/** The planned instructions in the order they run; blank entries are dropped. */
	steps: string[];
}

/** `value[key]` when `value` is an object, else undefined. */
function field(value: unknown, key: string): unknown {
	return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

function stepsOf(item: unknown): string[] {
	const raw = field(item, "steps");
	if (!Array.isArray(raw)) return [];
	return raw.filter((step): step is string => typeof step === "string" && step.trim() !== "");
}

/**
 * The ordered steps of each spawn of a `task` call's args: the args themselves for a single
 * spawn, each `tasks[]` item for a batch (items may mix `task` and `steps`; only stepped ones
 * are listed). A call without steps, and an item whose `steps` is missing, empty or not a list,
 * gives nothing. The SDK sends the first prompt at spawn and the later ones as each previous
 * step is delivered (`task/steps.ts`), but reports no step marker, so this is the plan only.
 */
export function taskSpawnSteps(args: unknown): TaskSpawnSteps[] {
	const tasks = field(args, "tasks");
	if (Array.isArray(tasks)) {
		return tasks.flatMap((item, index): TaskSpawnSteps[] => {
			const steps = stepsOf(item);
			if (steps.length === 0) return [];
			const name = field(item, "name");
			const label = typeof name === "string" && name.trim() !== "" ? name : `Task ${index + 1}`;
			return [{ index, label, steps }];
		});
	}
	const steps = stepsOf(args);
	return steps.length === 0 ? [] : [{ index: 0, steps }];
}
