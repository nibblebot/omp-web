import type { Component } from "solid-js";
import { setState, state } from "../state";

export const StatusBar: Component = () => (
	<header class="status-bar">
		<span class="status-model">{state.model || "no model"}</span>
		{state.thinking && <span class="status-thinking">thinking: {state.thinking}</span>}
		<label class="toggle">
			<input type="checkbox" checked={state.reveal} onChange={e => setState("reveal", e.currentTarget.checked)} />
			reveal queue
		</label>
		<label class="toggle">
			<input type="checkbox" checked={state.soften} onChange={e => setState("soften", e.currentTarget.checked)} />
			soft fade
		</label>
		<span class="status-dot" classList={{ streaming: state.streaming }} title={state.streaming ? "streaming" : "idle"} />
		{state.error && (
			<div class="error-banner">
				<span>{state.error}</span>
				<button onClick={() => setState("error", null)}>dismiss</button>
			</div>
		)}
	</header>
);
