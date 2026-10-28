import {
	createContext,
	createEffect,
	createMemo,
	createSignal,
	For,
	Match,
	on,
	Show,
	Switch,
	useContext,
	type Component,
	type JSX,
} from "solid-js";
import { Dynamic } from "solid-js/web";
import { effectiveStatus, type BackgroundJob } from "../../../chat/background-job";
import { toolKind, type ToolIconKey } from "../../../chat/tool-kinds";
import { capRows, toolRowLimit } from "../../../chat/tool-rows";
import { state, type ToolItem } from "../../../state";
import { Card } from "../../ui/Card";
import { createLazyOpen } from "../../ui/lazy-open";
import { BackgroundBadge } from "./BackgroundBadge";
import {
	BotIcon,
	BracesIcon,
	CodeIcon,
	FileTextIcon,
	GlobeIcon,
	ListChecksIcon,
	LoaderIcon,
	MessageCircleQuestionIcon,
	MessagesSquareIcon,
	PencilIcon,
	PlugIcon,
	SearchIcon,
	StopIcon,
	TerminalIcon,
	WarningIcon,
	WrenchIcon,
	type IconProps,
} from "../../ui/icons";

/** Rows of tool output a card shows before its "hidden lines" note (the Appearance sheet's Rows choice); Ctrl+O (toolsExpanded) reveals the rest. */
export const toolRowCap = (): number => toolRowLimit(state.display.toolRows);

/** Cards stay expanded while running (a call parked on a background job counts) or when the user toggles Ctrl+O. */
export const toolExpanded = (item: ToolItem): boolean =>
	state.toolsExpanded || effectiveStatus(item) === "running";

/**
 * Per-card row expansion. The "N hidden lines" button lifts the row cap for one card, the
 * touch route to what Ctrl+O (`toolsExpanded`, every card at once) shows. Ctrl+O resets the
 * per-card choice, as it does for card headers.
 */
export function createRowExpansion(item: () => ToolItem) {
	const [userExpanded, setUserExpanded] = createSignal(false);
	createEffect(
		on(
			() => state.toolsExpanded,
			() => setUserExpanded(false),
			{ defer: true },
		),
	);
	return {
		/** Every row shows: Ctrl+O, a running call or this card's own choice. */
		expanded: () => toolExpanded(item()) || userExpanded(),
		/** This card's own choice is on, so its note offers to fold the rows again. */
		userExpanded,
		toggle: () => setUserExpanded((v) => !v),
		/** The note button's label, or undefined when no note shows (nothing hidden, or Ctrl+O/running opened it). */
		noteLabel: (hidden: number): string | undefined => {
			if (hidden <= 0) return undefined;
			if (userExpanded()) return "Show fewer lines";
			return toolExpanded(item()) ? undefined : `Show ${hidden} hidden lines`;
		},
	};
}

/** The tool call a card renders; `ToolCardShell` stamps it on the card root as `data-tool-call-id` so a jump from elsewhere in the transcript finds the card (`chat/tool-jump.ts`). */
export const ToolCallIdContext = createContext<string>();

/** Provided as true by a consolidated run row: its cards draw header-only and open on click, as in Collapsed mode. */
export const RunMemberContext = createContext(false);

interface ToolShellProps {
	/** Tool name: the header label, also the key for the category color and icon (chat/tool-kinds.ts). */
	name: string;
	/** One-line argument shown after the name, in the monospace arg slot (command, path, pattern...). */
	arg?: JSX.Element;
	/** Replaces the icon, name and arg with custom header content (bash shows its `$ command`). */
	title?: JSX.Element;
	/** Tool status ("running" | "done" | "error" | "interrupted"): drives the card border and the right-edge status slot. */
	status?: string;
	/** Extra card class, e.g. "bash-tool". */
	class?: string;
	/** Extra header content between the arg and the status slot (diff +n −m). */
	meta?: JSX.Element;
	/** The job this call handed its card to: a badge with its clock sits before the status slot (chat/background-job.ts). */
	background?: BackgroundJob;
	/** Render as a <details> that stays open while running (GenericToolCard). */
	collapsible?: boolean;
	children?: JSX.Element;
}

const TOOL_ICONS: Record<ToolIconKey, Component<IconProps>> = {
	terminal: TerminalIcon,
	code: CodeIcon,
	"file-text": FileTextIcon,
	pencil: PencilIcon,
	search: SearchIcon,
	globe: GlobeIcon,
	braces: BracesIcon,
	bot: BotIcon,
	"messages-square": MessagesSquareIcon,
	"message-circle-question": MessageCircleQuestionIcon,
	"list-checks": ListChecksIcon,
	plug: PlugIcon,
	wrench: WrenchIcon,
};

/** Shared tool card: header ([icon] name arg meta, status slot pinned right) plus a tool-specific body. */
export const ToolCardShell: Component<ToolShellProps> = (props) => {
	// User intent for the <details> toggle. A trusted toggle that differs from
	// the reactive default is a user click; the browser also fires trusted
	// toggles for our own open changes (running → done), which match the default
	// and are ignored. Ctrl+O clears the intent on every card.
	const [userOpen, setUserOpen] = createSignal<boolean | null>(null);
	createEffect(
		on(
			() => state.toolsExpanded,
			() => setUserOpen(null),
			{ defer: true },
		),
	);
	const cardClass = () => (props.class ? `tool-card ${props.class}` : "tool-card");
	const kind = createMemo(() => toolKind(props.name));
	const toolCallId = useContext(ToolCallIdContext);
	// Collapsed mode, and a consolidated run's cards, draw every card header-only: a
	// <details> closed until clicked (or running, or Ctrl+O), whatever the card's body.
	const inRun = useContext(RunMemberContext);
	const headerOnly = () => inRun || state.display.toolCards === "collapsed";
	const collapsible = () => props.collapsible || headerOnly();
	const isOpen = () => userOpen() ?? (state.toolsExpanded || props.status === "running");
	// A <details> card that has never been open has no body in the DOM: it mounts on
	// the first open (click, Ctrl+O, running) and stays mounted after a close. Most
	// cards of a long session are never opened.
	const lazy = createLazyOpen(false);
	const bodyMounted = createMemo(
		(was: boolean) => was || !collapsible() || isOpen() || lazy.opened(),
		false,
	);
	return (
		<Card
			class={cardClass()}
			status={props.status}
			data={{ "tool-call-id": toolCallId }}
			collapsible={collapsible()}
			open={isOpen()}
			onClick={lazy.onClick}
			onToggle={(e) => {
				lazy.onToggle(e);
				if (
					e.isTrusted &&
					e.currentTarget.open !== (state.toolsExpanded || props.status === "running")
				)
					setUserOpen(e.currentTarget.open);
			}}
			header={
				<>
					<Show
						when={props.title}
						fallback={
							<>
								<span class="tool-kind" data-kind={kind().category}>
									<Dynamic component={TOOL_ICONS[kind().icon]} />
									<span class="tool-name">{props.name}</span>
								</span>
								<Show when={props.arg}>
									<span class="tool-arg">{props.arg}</span>
								</Show>
							</>
						}
					>
						{(title) => title()}
					</Show>
					{props.meta}
					<Show when={props.background}>{(job) => <BackgroundBadge job={job()} />}</Show>
					<Show when={props.status}>
						<span class="tool-state" data-status={props.status} title={props.status}>
							<Switch>
								<Match when={props.status === "running"}>
									<LoaderIcon class="tool-spin" />
								</Match>
								<Match when={props.status === "error"}>
									<WarningIcon />
								</Match>
								<Match when={props.status === "interrupted"}>
									<StopIcon />
								</Match>
							</Switch>
							<span class="visually-hidden">{props.status}</span>
						</span>
					</Show>
				</>
			}
		>
			<Show when={bodyMounted()}>{props.children}</Show>
		</Card>
	);
};

interface CollapsiblePreProps {
	item: ToolItem;
	/** Raw tool output; nothing renders while empty. */
	output: string;
	/** Lines shown while collapsed. */
	maxLines?: number;
	/** Keep the LAST N lines (terminal-style tail) instead of the first N. */
	tail?: boolean;
	/** Render numbered .write-line rows (read/write cards) instead of a bare <pre>. */
	numbered?: boolean;
	/** First line number when numbered (default 1). */
	startNo?: number;
}

/** Terminal output body with the shared "Show N hidden lines" button under it. */
export const CollapsibleOutput: Component<CollapsiblePreProps> = (props) => {
	const limit = () => props.maxLines ?? toolRowCap();
	const rows = createRowExpansion(() => props.item);
	const lines = createMemo(() => props.output.split("\n"));
	const capped = () => capRows(lines(), limit(), props.tail ? "tail" : "head");
	const shown = () => (rows.expanded() ? lines() : capped().shown);
	const hidden = () => capped().hidden;
	return (
		<Show when={props.output}>
			<Show when={props.numbered} fallback={<pre class="terminal">{shown().join("\n")}</pre>}>
				<For each={shown()}>
					{(line, i) => (
						<div class="write-line">
							<span class="line-no">{(props.startNo ?? 1) + i()}</span>
							{line}
						</div>
					)}
				</For>
			</Show>
			<Show when={rows.noteLabel(hidden())}>
				{(label) => (
					<button
						type="button"
						class="tool-collapsed-note"
						title="Ctrl+O expands every tool output"
						aria-expanded={rows.userExpanded()}
						onClick={rows.toggle}
					>
						{label()}
					</button>
				)}
			</Show>
		</Show>
	);
};
