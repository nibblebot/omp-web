import { onMount, type Component } from "solid-js";
import { MessageList } from "./components/MessageList";
import { PromptBox } from "./components/PromptBox";
import { StatusBar } from "./components/StatusBar";
import { connect } from "./state";

export const App: Component = () => {
	onMount(connect);
	return (
		<div class="app">
			<StatusBar />
			<MessageList />
			<PromptBox />
		</div>
	);
};
