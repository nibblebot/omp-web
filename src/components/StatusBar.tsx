import type { Component } from "solid-js";
import { setState, state } from "../state";

export const StatusBar: Component = () => (
	<header class="status-bar">
		<span class="status-model">{state.model ? `${state.model.provider}/${state.model.id}` : "no model"}</span>
		{state.thinkingLevel && <span class="status-thinking">thinking: {state.thinkingLevel}</span>}
		<label class="toggle">
			<input type="checkbox" checked={state.reveal} onChange={e => setState("reveal", e.currentTarget.checked)} />
			reveal queue
		</label>
		<label class="toggle">
			<input type="checkbox" checked={state.soften} onChange={e => setState("soften", e.currentTarget.checked)} />
			soft fade
		</label>
		{!state.connected && <span class="disconnected-pill">disconnected</span>}
		<span class="status-dot" classList={{ streaming: state.streaming }} title={state.streaming ? "streaming" : "idle"} />
		{state.error && (
			<div class="error-banner">
				<span>{state.error}</span>
				<button onClick={() => setState("error", null)}>dismiss</button>
			</div>
		)}
	</header>
);
