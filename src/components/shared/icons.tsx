/** Inline SVG icons vendored from Lucide (https://lucide.dev, ISC license) —
 *  no icon font dependency. Strokes follow currentColor so icons tint with
 *  their surrounding text/status color; the base .icon rule (src/styles/base.css)
 *  sizes them to 1em, and a `class` prop layers site-specific overrides
 *  (e.g. .daemon-worktree-icon). */
import type { Component, JSX } from "solid-js";

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

/** Filled square — stop control (the ■ glyph it replaces reads "stop", and a
 *  stroked outline would read as a checkbox next to SquareIcon). */
export const StopIcon: Component<IconProps> = (props) => (
	<Svg class={props.class}>
		<rect width="18" height="18" x="3" y="3" rx="2" fill="currentColor" stroke="none" />
	</Svg>
);

/** Vertical ellipsis — "more actions" menu trigger (Lucide ellipsis-vertical). */
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

export const SettingsIcon: Component<IconProps> = (props) => (
	<Svg class={props.class}>
		<path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915" />
		<circle cx="12" cy="12" r="3" />
	</Svg>
);

/** maximize-2 — expand-all affordance (⤢). */
export const ExpandIcon: Component<IconProps> = (props) => (
	<Svg class={props.class}>
		<path d="M15 3h6v6" />
		<path d="m21 3-7 7" />
		<path d="m3 21 7-7" />
		<path d="M9 21H3v-6" />
	</Svg>
);

/** file — changed-files glyph on daemon git rows. */
export const FileIcon: Component<IconProps> = (props) => (
	<Svg class={props.class}>
		<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
		<path d="M14 2v4a2 2 0 0 0 2 2h4" />
	</Svg>
);

/** panel-left — transcripts view toggle (◫). */
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

/** circle-dot — selected radio marker (● next to ○). */
export const CircleDotIcon: Component<IconProps> = (props) => (
	<Svg class={props.class}>
		<circle cx="12" cy="12" r="10" />
		<circle cx="12" cy="12" r="4" fill="currentColor" stroke="none" />
	</Svg>
);

/** loader-circle — in-progress status (◐). */
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

/** refresh-cw — restarting status (↻). */
export const RefreshIcon: Component<IconProps> = (props) => (
	<Svg class={props.class}>
		<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
		<path d="M21 3v5h-5" />
		<path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
		<path d="M8 16H3v5" />
	</Svg>
);

/** diamond — stopping status (◇). */
export const DiamondIcon: Component<IconProps> = (props) => (
	<Svg class={props.class}>
		<path d="M2.7 10.3a2.41 2.41 0 0 0 0 3.41l7.59 7.59a2.41 2.41 0 0 0 3.41 0l7.59-7.59a2.41 2.41 0 0 0 0-3.41l-7.59-7.59a2.41 2.41 0 0 0 3.41 0Z" />
	</Svg>
);

/** ban — aborted/abandoned status (⊘). */
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

/** git-branch — worktree marker on daemon rows (replaces the hand-drawn
 *  3-node glyph; sized/tinted by .daemon-worktree-icon in src/styles/fleet.css). */
export const WorktreeIcon: Component<IconProps> = (props) => (
	<Svg class={props.class}>
		<path d="M15 6a9 9 0 0 0-9 9V3" />
		<circle cx="18" cy="6" r="3" />
		<circle cx="6" cy="18" r="3" />
	</Svg>
);

/** trash-2 — destructive delete affordance (⌫). */
export const TrashIcon: Component<IconProps> = (props) => (
	<Svg class={props.class}>
		<path d="M3 6h18" />
		<path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
		<path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
		<line x1="10" x2="10" y1="11" y2="17" />
		<line x1="14" x2="14" y1="11" y2="17" />
	</Svg>
);
