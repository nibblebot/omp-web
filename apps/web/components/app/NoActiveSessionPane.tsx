import type { Component } from "solid-js";

/** No live session (the attached session was stopped,
 *  removed, or never picked): a quiet centered hint replaces the whole chat
 *  column. Header/stream/composer all belong to a session that is gone. */
export const NoActiveSessionPane: Component = () => (
	<div class="roster-empty-pane">
		<p class="roster-empty-title">No active session</p>
		<p class="roster-empty-hint">Pick a workspace from the sidebar to open its session.</p>
	</div>
);
