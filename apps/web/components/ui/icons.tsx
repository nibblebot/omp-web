/** Inline SVG icons vendored from Lucide (https://lucide.dev, ISC license),
 *  with no icon font dependency. Strokes follow currentColor so icons tint with
 *  their surrounding text/status color; the base .icon rule (src/styles/base.css)
 *  sizes them to 1em, and a `class` prop layers site-specific overrides
 *  (e.g. .daemon-worktree-icon). */
import { createUniqueId, type Component, type JSX } from "solid-js";

export type IconProps = { class?: string };

const Svg: Component<IconProps & { children?: JSX.Element }> = (props) => (
	<svg
		class={props.class ? `icon ${props.class}` : "icon"}
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		stroke-width="2"
		stroke-linecap="round"
		stroke-linejoin="round"
		aria-hidden="true"
	>
		{props.children}
	</svg>
);

export const MenuIcon: Component<IconProps> = (props) => (
	<Svg class={props.class}>
		<path d="M4 5h16" />
		<path d="M4 12h16" />
		<path d="M4 19h16" />
	</Svg>
);

export const XIcon: Component<IconProps> = (props) => (
	<Svg class={props.class}>
		<path d="M18 6 6 18" />
		<path d="m6 6 12 12" />
	</Svg>
);

export const PlusIcon: Component<IconProps> = (props) => (
	<Svg class={props.class}>
		<path d="M5 12h14" />
		<path d="M12 5v14" />
	</Svg>
);

export const MinusIcon: Component<IconProps> = (props) => (
	<Svg class={props.class}>
		<path d="M5 12h14" />
	</Svg>
);

/** Filled square used as the stop control (the ■ glyph it replaces reads
 *  "stop", and a stroked outline would read as a checkbox next to SquareIcon). */
export const StopIcon: Component<IconProps> = (props) => (
	<Svg class={props.class}>
		<rect width="18" height="18" x="3" y="3" rx="2" fill="currentColor" stroke="none" />
	</Svg>
);

/** Vertical ellipsis used as the "more actions" menu trigger (Lucide ellipsis-vertical). */
export const DotsIcon: Component<IconProps> = (props) => (
	<Svg class={props.class}>
		<circle cx="12" cy="12" r="1" />
		<circle cx="12" cy="19" r="1" />
		<circle cx="12" cy="5" r="1" />
	</Svg>
);

export const InfoIcon: Component<IconProps> = (props) => (
	<Svg class={props.class}>
		<circle cx="12" cy="12" r="10" />
		<path d="M12 16v-4" />
		<path d="M12 8h.01" />
	</Svg>
);

/** Warning triangle (⚠), drawn with Lucide's triangle-alert. */
export const WarningIcon: Component<IconProps> = (props) => (
	<Svg class={props.class}>
		<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
		<path d="M12 9v4" />
		<path d="M12 17h.01" />
	</Svg>
);

/** Drag handle (six dots), drawn with Lucide's grip-vertical. */
export const GripVerticalIcon: Component<IconProps> = (props) => (
	<Svg class={props.class}>
		<circle cx="9" cy="5" r="1" />
		<circle cx="9" cy="12" r="1" />
		<circle cx="9" cy="19" r="1" />
		<circle cx="15" cy="5" r="1" />
		<circle cx="15" cy="12" r="1" />
		<circle cx="15" cy="19" r="1" />
	</Svg>
);

export const SettingsIcon: Component<IconProps> = (props) => (
	<Svg class={props.class}>
		<path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915" />
		<circle cx="12" cy="12" r="3" />
	</Svg>
);

/** Expand-all affordance (⤢), drawn with Lucide's maximize-2. */
export const ExpandIcon: Component<IconProps> = (props) => (
	<Svg class={props.class}>
		<path d="M15 3h6v6" />
		<path d="m21 3-7 7" />
		<path d="m3 21 7-7" />
		<path d="M9 21H3v-6" />
	</Svg>
);

/** Changed-files glyph on daemon git rows, drawn with Lucide's file. */
export const FileIcon: Component<IconProps> = (props) => (
	<Svg class={props.class}>
		<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
		<path d="M14 2v4a2 2 0 0 0 2 2h4" />
	</Svg>
);

/** Transcripts view toggle (◫), drawn with Lucide's panel-left. */
export const PanelLeftIcon: Component<IconProps> = (props) => (
	<Svg class={props.class}>
		<rect width="18" height="18" x="3" y="3" rx="2" />
		<path d="M9 3v18" />
	</Svg>
);

export const ArrowUpIcon: Component<IconProps> = (props) => (
	<Svg class={props.class}>
		<path d="m5 12 7-7 7 7" />
		<path d="M12 19V5" />
	</Svg>
);

export const ArrowDownIcon: Component<IconProps> = (props) => (
	<Svg class={props.class}>
		<path d="M12 5v14" />
		<path d="m19 12-7 7-7-7" />
	</Svg>
);

export const ArrowLeftIcon: Component<IconProps> = (props) => (
	<Svg class={props.class}>
		<path d="m12 19-7-7 7-7" />
		<path d="M19 12H5" />
	</Svg>
);

export const ArrowRightIcon: Component<IconProps> = (props) => (
	<Svg class={props.class}>
		<path d="M5 12h14" />
		<path d="m12 5 7 7-7 7" />
	</Svg>
);

export const ChevronDownIcon: Component<IconProps> = (props) => (
	<Svg class={props.class}>
		<path d="m6 9 6 6 6-6" />
	</Svg>
);

export const ChevronRightIcon: Component<IconProps> = (props) => (
	<Svg class={props.class}>
		<path d="m9 18 6-6-6-6" />
	</Svg>
);

export const ChevronUpIcon: Component<IconProps> = (props) => (
	<Svg class={props.class}>
		<path d="m18 15-6-6-6 6" />
	</Svg>
);

export const SquareIcon: Component<IconProps> = (props) => (
	<Svg class={props.class}>
		<rect width="18" height="18" x="3" y="3" rx="2" />
	</Svg>
);

export const SquareCheckIcon: Component<IconProps> = (props) => (
	<Svg class={props.class}>
		<rect width="18" height="18" x="3" y="3" rx="2" />
		<path d="m9 12 2 2 4-4" />
	</Svg>
);

export const CircleIcon: Component<IconProps> = (props) => (
	<Svg class={props.class}>
		<circle cx="12" cy="12" r="10" />
	</Svg>
);

/** Selected radio marker (● next to ○), drawn with Lucide's circle-dot. */
export const CircleDotIcon: Component<IconProps> = (props) => (
	<Svg class={props.class}>
		<circle cx="12" cy="12" r="10" />
		<circle cx="12" cy="12" r="4" fill="currentColor" stroke="none" />
	</Svg>
);

/** In-progress status (◐), drawn with Lucide's loader-circle. */
export const LoaderIcon: Component<IconProps> = (props) => (
	<Svg class={props.class}>
		<path d="M21 12a9 9 0 1 1-6.219-8.56" />
	</Svg>
);

export const CheckIcon: Component<IconProps> = (props) => (
	<Svg class={props.class}>
		<path d="M20 6 9 17l-5-5" />
	</Svg>
);

/** Restarting status (↻), drawn with Lucide's refresh-cw. */
export const RefreshIcon: Component<IconProps> = (props) => (
	<Svg class={props.class}>
		<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
		<path d="M21 3v5h-5" />
		<path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
		<path d="M8 16H3v5" />
	</Svg>
);

/** Stopping status (◇), drawn with Lucide's diamond. */
export const DiamondIcon: Component<IconProps> = (props) => (
	<Svg class={props.class}>
		<path d="M2.7 10.3a2.41 2.41 0 0 0 0 3.41l7.59 7.59a2.41 2.41 0 0 0 3.41 0l7.59-7.59a2.41 2.41 0 0 0 0-3.41l-7.59-7.59a2.41 2.41 0 0 0 3.41 0Z" />
	</Svg>
);

/** Aborted/abandoned status (⊘), drawn with Lucide's ban. */
export const BanIcon: Component<IconProps> = (props) => (
	<Svg class={props.class}>
		<circle cx="12" cy="12" r="10" />
		<path d="M4.929 4.929 19.07 19.071" />
	</Svg>
);

export const CornerDownRightIcon: Component<IconProps> = (props) => (
	<Svg class={props.class}>
		<path d="m15 10 5 5-5 5" />
		<path d="M4 4v7a4 4 0 0 0 4 4h12" />
	</Svg>
);

/** Worktree marker on daemon rows, drawn with Lucide's git-branch. It replaces
 *  the hand-drawn 3-node glyph; sized/tinted by .daemon-worktree-icon in
 *  src/styles/fleet.css. */
export const WorktreeIcon: Component<IconProps> = (props) => (
	<Svg class={props.class}>
		<path d="M15 6a9 9 0 0 0-9 9V3" />
		<circle cx="18" cy="6" r="3" />
		<circle cx="6" cy="18" r="3" />
	</Svg>
);

/** Main-worktree marker on project-group root rows, drawn with Lucide's house.
 *  This is the checkout the project was registered from, and linked worktrees
 *  nest beneath it. Sized/tinted by .daemon-root-icon in src/styles/fleet.css. */
export const RootIcon: Component<IconProps> = (props) => (
	<Svg class={props.class}>
		<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
		<path d="M9 22V12h6v10" />
	</Svg>
);

/** Destructive delete affordance (⌫), drawn with Lucide's trash-2. */
export const TrashIcon: Component<IconProps> = (props) => (
	<Svg class={props.class}>
		<path d="M3 6h18" />
		<path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
		<path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
		<line x1="10" x2="10" y1="11" y2="17" />
		<line x1="14" x2="14" y1="11" y2="17" />
	</Svg>
);

/** Chat mode glyph (the live-conversation surface, ▸_), drawn with Lucide's terminal. */
export const TerminalIcon: Component<IconProps> = (props) => (
	<Svg class={props.class}>
		<polyline points="4 17 10 11 4 5" />
		<line x1="12" x2="20" y1="19" y2="19" />
	</Svg>
);

/** Analysis mode glyph (the transcripts/stats surface), drawn with Lucide's bar-chart-3. */
export const BarChart3Icon: Component<IconProps> = (props) => (
	<Svg class={props.class}>
		<path d="M3 3v18h18" />
		<path d="M18 17V9" />
		<path d="M13 17V5" />
		<path d="M8 17v-3" />
	</Svg>
);

/** Settings search field magnifier, drawn with Lucide's search. */
export const SearchIcon: Component<IconProps> = (props) => (
	<Svg class={props.class}>
		<circle cx="11" cy="11" r="8" />
		<path d="m21 21-4.3-4.3" />
	</Svg>
);

/** Settings tab glyphs, drawn with Lucide's pencil, crosshair, keyboard, layers, database, wand, list, server, package, monitor, flask. */
export const PencilIcon: Component<IconProps> = (props) => (
	<Svg class={props.class}>
		<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
		<path d="m15 5 4 4" />
	</Svg>
);

export const CrosshairIcon: Component<IconProps> = (props) => (
	<Svg class={props.class}>
		<circle cx="12" cy="12" r="10" />
		<path d="M22 12h-4" />
		<path d="M6 12H2" />
		<path d="M12 6V2" />
		<path d="M12 22v-4" />
	</Svg>
);

export const KeyboardIcon: Component<IconProps> = (props) => (
	<Svg class={props.class}>
		<rect width="20" height="16" x="2" y="4" rx="2" />
		<path d="M6 8h.001" />
		<path d="M10 8h.001" />
		<path d="M14 8h.001" />
		<path d="M18 8h.001" />
		<path d="M8 12h.001" />
		<path d="M12 12h.001" />
		<path d="M16 12h.001" />
		<path d="M7 16h10" />
	</Svg>
);

export const LayersIcon: Component<IconProps> = (props) => (
	<Svg class={props.class}>
		<path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z" />
		<path d="M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12" />
		<path d="M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17" />
	</Svg>
);

export const DatabaseIcon: Component<IconProps> = (props) => (
	<Svg class={props.class}>
		<ellipse cx="12" cy="5" rx="9" ry="3" />
		<path d="M3 5V19A9 3 0 0 0 21 19V5" />
		<path d="M3 12A9 3 0 0 0 21 12" />
	</Svg>
);

export const WandIcon: Component<IconProps> = (props) => (
	<Svg class={props.class}>
		<path d="M15 4V2" />
		<path d="M15 16v-2" />
		<path d="M8 9h2" />
		<path d="M20 9h2" />
		<path d="M17.8 11.8 19 13" />
		<path d="M15 9h.01" />
		<path d="M17.8 6.2 19 5" />
		<path d="m3 21 9-9" />
		<path d="M12.2 6.2 11 5" />
	</Svg>
);

export const ListIcon: Component<IconProps> = (props) => (
	<Svg class={props.class}>
		<path d="M3 12h.01" />
		<path d="M3 18h.01" />
		<path d="M3 6h.01" />
		<path d="M8 12h13" />
		<path d="M8 18h13" />
		<path d="M8 6h13" />
	</Svg>
);

export const ServerIcon: Component<IconProps> = (props) => (
	<Svg class={props.class}>
		<rect width="20" height="8" x="2" y="2" rx="2" ry="2" />
		<rect width="20" height="8" x="2" y="14" rx="2" ry="2" />
		<path d="M6 6h.01" />
		<path d="M6 18h.01" />
	</Svg>
);

export const PackageIcon: Component<IconProps> = (props) => (
	<Svg class={props.class}>
		<path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z" />
		<path d="M12 22V12" />
		<path d="m3.3 7 7.703 4.734a2 2 0 0 0 1.994 0L20.7 7" />
		<path d="m7.5 4.27 9 5.15" />
	</Svg>
);

/** Lucide `lock`: a worktree held by `git worktree lock`. */
export const LockIcon: Component<IconProps> = (props) => (
	<Svg class={props.class}>
		<rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
		<path d="M7 11V7a5 5 0 0 1 10 0v4" />
	</Svg>
);

/** Lucide `folder`: a directory in the Add project chooser. */
export const FolderIcon: Component<IconProps> = (props) => (
	<Svg class={props.class}>
		<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
	</Svg>
);

/** Lucide `house`: the home shortcut in the Add project chooser. */
export const HomeIcon: Component<IconProps> = (props) => (
	<Svg class={props.class}>
		<path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8" />
		<path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
	</Svg>
);

export const MonitorIcon: Component<IconProps> = (props) => (
	<Svg class={props.class}>
		<rect width="20" height="14" x="2" y="3" rx="2" />
		<path d="M8 21h8" />
		<path d="M12 17v4" />
	</Svg>
);

export const FlaskIcon: Component<IconProps> = (props) => (
	<Svg class={props.class}>
		<path d="M10 2v7.527a2 2 0 0 1-.211.896L4.72 20.55a1 1 0 0 0 .9 1.45h12.76a1 1 0 0 0 .9-1.45l-5.069-10.127A2 2 0 0 1 14 9.527V2" />
		<path d="M8.5 2h7" />
		<path d="M7 16h10" />
	</Svg>
);

export const PaperclipIcon: Component<IconProps> = (props) => (
	<Svg class={props.class}>
		<path d="m16 6-8.414 8.586a2 2 0 0 0 2.829 2.829l8.414-8.586a4 4 0 1 0-5.657-5.657l-8.379 8.551a6 6 0 1 0 8.485 8.485l8.379-8.551" />
	</Svg>
);

/** Running-subagents glyph in the composer actions, drawn with Lucide's bot. */
export const BotIcon: Component<IconProps> = (props) => (
	<Svg class={props.class}>
		<path d="M12 8V4H8" />
		<rect width="16" height="12" x="4" y="8" rx="2" />
		<path d="M2 14h2" />
		<path d="M20 14h2" />
		<path d="M15 13v2" />
		<path d="M9 13v2" />
	</Svg>
);

/** Official omp mark, vendored from https://omp.sh/favicon.svg. A brand logo,
 *  so unlike the Lucide set it keeps its own fill colors instead of
 *  currentColor. */
export const OmpLogoIcon: Component<IconProps> = (props) => (
	<svg class={props.class ? `icon ${props.class}` : "icon"} viewBox="0 0 64 64" aria-hidden="true">
		<defs>
			<linearGradient id="omp-logo-gradient" x1="0" y1="0" x2="1" y2="1">
				<stop offset="0" stop-color="#ed4abf" />
				<stop offset=".5" stop-color="#9b4dff" />
				<stop offset="1" stop-color="#5ad8e6" />
			</linearGradient>
		</defs>
		<rect width="64" height="64" rx="12" fill="#0f0a14" />
		<path fill="url(#omp-logo-gradient)" d="M14 16h36v8H40v32h-8V24h-6v22h-8V24h-4z" />
	</svg>
);

/** Anthropic wordmark glyph, vendored from Simple Icons (https://simpleicons.org,
 *  CC0). Monochrome brand mark, so it fills with currentColor. */
export const AnthropicLogoIcon: Component<IconProps> = (props) => (
	<svg
		class={props.class ? `icon ${props.class}` : "icon"}
		viewBox="0 0 24 24"
		fill="currentColor"
		aria-hidden="true"
	>
		<path d="M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z" />
	</svg>
);

/** OpenAI blossom, vendored from Simple Icons (https://simpleicons.org, CC0).
 *  Monochrome brand mark, so it fills with currentColor. */
export const OpenAILogoIcon: Component<IconProps> = (props) => (
	<svg
		class={props.class ? `icon ${props.class}` : "icon"}
		viewBox="0 0 24 24"
		fill="currentColor"
		aria-hidden="true"
	>
		<path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
	</svg>
);

/** OpenCode mark, vendored from https://opencode.ai/favicon.svg without its
 *  dark tile, framed square. Fills with currentColor; the inner block keeps the
 *  original's dimmed second tone as reduced opacity. */
export const OpenCodeLogoIcon: Component<IconProps> = (props) => (
	<svg
		class={props.class ? `icon ${props.class}` : "icon"}
		viewBox="96 96 320 320"
		fill="currentColor"
		aria-hidden="true"
	>
		<path d="M320 224V352H192V224H320Z" opacity=".4" />
		<path
			fill-rule="evenodd"
			clip-rule="evenodd"
			d="M384 416H128V96H384V416ZM320 160H192V352H320V160Z"
		/>
	</svg>
);

/** The omp-web brand mark (wave-crest: amber sun over three curling crests on
 *  a rounded tile). A brand logo, so it keeps its own colors instead of
 *  currentColor; only the tile and base band switch with the app theme, via
 *  light-dark() in base.css. The clip-path id is per instance because the
 *  icon can render several times on one page. */
export const OmpWebLogoIcon: Component<IconProps> = (props) => {
	const clipId = `omp-web-logo-clip-${createUniqueId()}`;
	const crest =
		"M-4 44C12 44 20 33 24 25C30 11 44 4 54 12C63 20 58 35 42 38C52 33 54 27 49 23C43 18 36 23 33 32C29 43 20 53 -4 59Z";
	return (
		<svg
			class={props.class ? `icon ${props.class}` : "icon"}
			viewBox="0 0 64 64"
			aria-hidden="true"
		>
			<defs>
				<clipPath id={clipId}>
					<rect width="64" height="64" rx="14" />
				</clipPath>
			</defs>
			<rect class="omp-web-logo-tile" width="64" height="64" rx="14" />
			<g clip-path={`url(#${clipId})`}>
				<circle cx="14" cy="16" r="7.5" fill="#f2b84b" />
				<path class="omp-web-logo-base" transform="translate(-8 21)" d={crest} />
				<path transform="translate(-4 10.5)" fill="#ec8a2f" d={crest} />
				<path fill="#c4552d" d={crest} />
			</g>
		</svg>
	);
};
