import { For, type Component } from "solid-js";
import { Dynamic } from "solid-js/web";
import { buildInfo } from "../../build-info";
import { featureSidebarHeader } from "../../features/registry";
import { OmpWebLogoIcon, PanelLeftIcon } from "../ui/icons";
import { ViewSwitch } from "./ViewSwitch";

const versionTitle = (): string => {
	const parts = [buildInfo.version && `v${buildInfo.version}`, buildInfo.gitHash].filter(Boolean);
	return parts.length > 0 ? `omp-web ${parts.join(" ")}` : "omp-web";
};

/**
 * Top row of both sidebars (Chat roster and Analysis transcripts): the
 * omp-web logo mark and wordmark (build version on hover) flush left, then
 * the Chat/Analysis switch, the debug button (feature slot, absent when the
 * debug feature is off), and the sidebar toggle rightmost, which collapses
 * this sidebar.
 */
export const SidebarHeader: Component<{ onCollapse: () => void }> = (props) => (
	<div class="sidebar-header">
		<span class="sidebar-wordmark" title={versionTitle()}>
			<OmpWebLogoIcon />
			<span class="sidebar-wordmark-text">omp-web</span>
		</span>
		<ViewSwitch />
		<For each={featureSidebarHeader()}>
			{(slot) => (slot.debugButton ? <Dynamic component={slot.debugButton} /> : null)}
		</For>
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
