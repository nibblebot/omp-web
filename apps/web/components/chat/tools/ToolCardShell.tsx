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
import { state, type ToolItem } from "../../../state";
import { Card } from "../../ui/Card";
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

/** Lines of tool output shown while collapsed; Ctrl+O (toolsExpanded) reveals the rest. */
export const COLLAPSED_LINES = 20;

/** Cards stay expanded while running (a call parked on a background job counts) or when the user toggles Ctrl+O. */
export const toolExpanded = (item: ToolItem): boolean =>
	state.toolsExpanded || effectiveStatus(item) === "running";

/** The tool call a card renders; `ToolCardShell` stamps it on the card root as `data-tool-call-id` so a jump from elsewhere in the transcript finds the card (`chat/tool-jump.ts`). */
export const ToolCallIdContext = createContext<string>();

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
	// and are ignored. Ctrl+O / the header kebab clears the intent on every card.
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
	return (
		<Card
			class={cardClass()}
			status={props.status}
			data={{ "tool-call-id": toolCallId }}
			collapsible={props.collapsible}
			open={userOpen() ?? (state.toolsExpanded || props.status === "running")}
			onToggle={(e) => {
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
			{props.children}
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

/** Terminal output body with the shared "N hidden lines (Ctrl+O to expand)" tail. */
export const CollapsibleOutput: Component<CollapsiblePreProps> = (props) => {
	const max = () => props.maxLines ?? COLLAPSED_LINES;
	const expanded = () => toolExpanded(props.item);
	const lines = () => props.output.split("\n");
	const shown = () =>
		expanded() ? lines() : props.tail ? lines().slice(-max()) : lines().slice(0, max());
	const hidden = () => Math.max(0, lines().length - max());
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
			<Show when={!expanded() && hidden() > 0}>
				<div class="tool-collapsed-note">{hidden()} hidden lines (Ctrl+O to expand)</div>
			</Show>
		</Show>
	);
};
