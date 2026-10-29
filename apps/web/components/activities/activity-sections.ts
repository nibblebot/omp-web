import type { ActivitySectionId } from "../../store/activities";
import { BotIcon, LayersIcon, ListChecksIcon, ServerIcon } from "../ui/icons";
import { DaemonsPopover } from "./DaemonsPopover";
import { JobsPopover } from "./JobsPopover";
import { SubagentsPopover } from "./SubagentsPopover";
import { TodosPopover } from "./TodosPopover";

/**
 * The activity buttons' sections in display order, their icons and their popovers: shared by
 * the ActivityBar (wide layouts) and the header's More actions menu (MainHeader, phones).
 * Each button shows only while its section has items.
 */
export const ACTIVITY_SECTIONS: readonly ActivitySectionId[] = [
	"subagents",
	"jobs",
	"daemons",
	"todos",
];

export const ACTIVITY_ICON = {
	subagents: BotIcon,
	jobs: LayersIcon,
	daemons: ServerIcon,
	todos: ListChecksIcon,
} as const;

export const ACTIVITY_POPOVER = {
	subagents: SubagentsPopover,
	jobs: JobsPopover,
	daemons: DaemonsPopover,
	todos: TodosPopover,
} as const;
