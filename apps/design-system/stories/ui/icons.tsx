import { For, type Component, type JSX } from "solid-js";
import {
	ArrowDownIcon,
	ArrowLeftIcon,
	ArrowRightIcon,
	ArrowUpIcon,
	BanIcon,
	BarChart3Icon,
	CheckIcon,
	ChevronDownIcon,
	ChevronRightIcon,
	ChevronUpIcon,
	CircleDotIcon,
	CircleIcon,
	CornerDownRightIcon,
	DiamondIcon,
	DotsIcon,
	ExpandIcon,
	FileIcon,
	InfoIcon,
	LoaderIcon,
	MenuIcon,
	MinusIcon,
	OmpLogoIcon,
	PanelLeftIcon,
	PlusIcon,
	RefreshIcon,
	RootIcon,
	SettingsIcon,
	SquareCheckIcon,
	SquareIcon,
	StopIcon,
	TerminalIcon,
	TrashIcon,
	WorktreeIcon,
	XIcon,
	type IconProps,
	SearchIcon,
	PencilIcon,
	CrosshairIcon,
	KeyboardIcon,
	LayersIcon,
	DatabaseIcon,
	WandIcon,
	ListIcon,
	ServerIcon,
	PackageIcon,
	LockIcon,
	FolderIcon,
	HomeIcon,
	MonitorIcon,
	FlaskIcon,
	WarningIcon,
	GripVerticalIcon,
	PaperclipIcon,
	AnthropicLogoIcon,
	OpenAILogoIcon,
	OpenCodeLogoIcon,
} from "../../../web/components/ui/icons";
import { defineStory } from "../../registry";

const ICONS: Record<string, Component<IconProps>> = {
	MenuIcon,
	XIcon,
	PlusIcon,
	MinusIcon,
	StopIcon,
	DotsIcon,
	InfoIcon,
	SettingsIcon,
	ExpandIcon,
	FileIcon,
	PanelLeftIcon,
	ArrowUpIcon,
	ArrowDownIcon,
	ArrowLeftIcon,
	ArrowRightIcon,
	ChevronDownIcon,
	ChevronRightIcon,
	ChevronUpIcon,
	SquareIcon,
	SquareCheckIcon,
	CircleIcon,
	CircleDotIcon,
	LoaderIcon,
	CheckIcon,
	RefreshIcon,
	DiamondIcon,
	BanIcon,
	CornerDownRightIcon,
	WorktreeIcon,
	RootIcon,
	TrashIcon,
	TerminalIcon,
	BarChart3Icon,
	SearchIcon,
	PencilIcon,
	CrosshairIcon,
	KeyboardIcon,
	LayersIcon,
	DatabaseIcon,
	WandIcon,
	ListIcon,
	ServerIcon,
	PackageIcon,
	LockIcon,
	FolderIcon,
	HomeIcon,
	MonitorIcon,
	FlaskIcon,
	WarningIcon,
	GripVerticalIcon,
	PaperclipIcon,
	OmpLogoIcon,
	AnthropicLogoIcon,
	OpenAILogoIcon,
	OpenCodeLogoIcon,
};

const ICON_FILE = "apps/web/components/ui/icons.tsx";
const ICON_LIST = Object.entries(ICONS);

/** Every icon in one row at the current text size and color. */
const iconRow = (): JSX.Element => (
	<span class="ds-icon-row">
		<For each={ICON_LIST}>{([, Icon]) => <Icon />}</For>
	</span>
);

/**
 * Every icon export from shared/icons.tsx on one page, in its own nav
 * section. Icons size to 1em and stroke with currentColor (base .icon rule),
 * so the size and color variants render the set inside different text.
 */
export default defineStory({
	id: "icons",
	title: "Icons",
	section: "Icons",
	component: ICON_LIST.map(([name]) => ({ file: ICON_FILE, export: name })),
	variants: [
		{
			name: "Gallery",
			description: `All ${ICON_LIST.length} Lucide icons the app vendors, by export name.`,
			render: () => (
				<div class="ds-icon-grid">
					<For each={ICON_LIST}>
						{([name, Icon]) => (
							<div class="ds-icon-tile">
								<span class="ds-icon-glyph">
									<Icon />
								</span>
								<code>{name}</code>
							</div>
						)}
					</For>
				</div>
			),
		},
		{
			name: "Sizes",
			description: "The set inside caption, body, heading, and display text: always 1em square.",
			render: () => (
				<div>
					<p class="ds-chip-note">caption (small)</p>
					<small>{iconRow()}</small>
					<p class="ds-chip-note">body (1em)</p>
					<p>{iconRow()}</p>
					<p class="ds-chip-note">heading (h3)</p>
					<h3>{iconRow()}</h3>
					<p class="ds-chip-note">display (h1)</p>
					<h1>{iconRow()}</h1>
				</div>
			),
		},
		{
			name: "Colors",
			description: "Strokes follow currentColor, so the set tints with its container.",
			render: () => (
				<div>
					<p>{iconRow()}</p>
					<p>
						<span class="ds-badge">{iconRow()}</span>
					</p>
					<p>
						<span class="ds-chip-plain">{iconRow()}</span>
					</p>
					<div class="toast toast-error">{iconRow()}</div>
				</div>
			),
		},
	],
});
