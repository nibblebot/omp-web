import type { Component } from "solid-js";

/** No live session (the attached daemon was stopped,
 *  removed, or never picked): a quiet centered hint replaces the whole chat
 *  column. Header/stream/composer all belong to a session that is gone. */
export const NoActiveSessionPane: Component = () => (
	<div class="roster-empty-pane">
		<p class="roster-empty-title">No active session</p>
		<p class="roster-empty-hint">Pick a daemon from the sidebar to start a session.</p>
	</div>
);
