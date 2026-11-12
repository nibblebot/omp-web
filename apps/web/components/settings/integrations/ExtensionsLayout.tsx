import { onMount, type Component, type JSX } from "solid-js";
import {
	extensionsDrill,
	extensionsQuery,
	leaveExtensionDetail,
	searchAutofocus,
	setExtensionsQuery,
} from "../../../store/integrations";

/**
 * The Skills and MCP tabs' frame: a search over the list with the selected row's detail beside
 * it. In a narrow container the detail replaces the list, with Back.
 */
export const ExtensionsLayout: Component<{
	/** Search placeholder and accessible name, e.g. "Search skills". */
	search: string;
	/** Buttons beside the search input (the MCP tab's Add server). */
	actions?: JSX.Element;
	/** Notices, rows, and loading or empty notes under the search. */
	list: JSX.Element;
	detail: JSX.Element;
	/** Runs on Back in the narrow layout, before the list shows again. */
	onBack?: () => void;
}> = (props) => {
	let search!: HTMLInputElement;
	onMount(() => {
		if (searchAutofocus()) search.focus();
	});
	const back = () => {
		props.onBack?.();
		leaveExtensionDetail();
	};
	return (
		<div class="integrations-tab extensions-view">
			<div class="extensions-layout" data-view={extensionsDrill() ? "detail" : "list"}>
				<div class="extensions-list-pane">
					<div class="extensions-search">
						<input
							ref={search}
							class="picker-filter"
							type="search"
							aria-label={props.search}
							placeholder={props.search}
							value={extensionsQuery()}
							onInput={(e) => setExtensionsQuery(e.currentTarget.value)}
						/>
						{props.actions}
					</div>
					{props.list}
				</div>
				<div class="extensions-detail-pane">
					<button type="button" class="settings-control-btn extensions-back" onClick={back}>
						Back
					</button>
					{props.detail}
				</div>
			</div>
		</div>
	);
};
