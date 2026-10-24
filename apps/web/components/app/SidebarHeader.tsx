import type { Component, JSX } from "solid-js";
import { buildInfo } from "../../build-info";
import { OmpWebLogoIcon, PanelLeftIcon } from "../ui/icons";

const versionTitle = (): string => {
	const parts = [buildInfo.version && `v${buildInfo.version}`, buildInfo.gitHash].filter(Boolean);
	return parts.length > 0 ? `omp-web ${parts.join(" ")}` : "omp-web";
};

/**
 * Top row of both sidebars (Chat roster and Analysis transcripts): the
 * omp-web logo mark and wordmark (build version on hover) flush left, then
 * the sidebar's own `actions` (the roster passes its running-only filter) and
 * the sidebar toggle rightmost, which collapses this sidebar.
 */
export const SidebarHeader: Component<{ onCollapse: () => void; actions?: JSX.Element }> = (
	props,
) => (
	<div class="sidebar-header">
		<span class="sidebar-wordmark" title={versionTitle()}>
			<OmpWebLogoIcon />
			<span class="sidebar-wordmark-text">omp-web</span>
		</span>
		{props.actions}
		<button
			type="button"
			class="sidebar-icon-btn"
			onClick={() => props.onCollapse()}
			title="Close sidebar"
			aria-label="Close sidebar"
			aria-expanded={true}
		>
			<PanelLeftIcon />
		</button>
	</div>
);
