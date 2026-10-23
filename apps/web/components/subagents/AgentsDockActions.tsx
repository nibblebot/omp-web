import type { Component } from "solid-js";
import { AgentsFilterToggle } from "./AgentsFilterToggle";
import { AgentsModeToggle } from "./AgentsModeToggle";

/** The agents dock header controls: the Running / All filter, then the single / accordion view toggle. */
export const AgentsDockActions: Component = () => (
	<div class="agents-dock-actions">
		<AgentsFilterToggle />
		<AgentsModeToggle />
	</div>
);
