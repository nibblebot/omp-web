import type { Component } from "solid-js";

// ---------------------------------------------------------------------------
// Full-screen gate shown INSTEAD of the app shell when the page's /events
// peer is a bare session daemon rather than the fleet edge (state.fleetRequired).
// The daemon serves the wire API only, so there is no roster, no session list,
// and no UI to render; the copy points the user at the fleet. Shell-independent
// on purpose: it renders even though no shell state exists.
// ---------------------------------------------------------------------------

export const FleetRequiredNotice: Component = () => (
	<div class="fleet-required">
		<h1 class="fleet-required-title">omp-fleet required</h1>
		<p class="fleet-required-body">
			This page is connected to a session daemon, which serves the wire API but no web UI. The web
			UI is served by the fleet: start it with <code>omp-web</code> and open the Web UI URL it
			prints.
		</p>
	</div>
);
