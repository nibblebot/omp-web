/** One component declaration found under apps/web, with its place in the render graph. */
export interface GraphNode {
	/** `<repo-relative file>#<local name>`; unique even when two files declare the same name. */
	id: string;
	/** Local declaration name. */
	name: string;
	/** Repo-relative source path, e.g. apps/web/components/ui/CopyButton.tsx. */
	file: string;
	line: number;
	/** Names this file exports the component under ("default" included); empty for file-local components. */
	exportNames: string[];
	/** Folder group: "ui", "chat/tools", "fleet/sidebar", "tx/transcript/rows", "app" (root files). */
	group: string;
	/** 0 when it renders no project component, else 1 + the highest child tier. */
	tier: number;
	/** Ids of the distinct project components this one renders. */
	children: string[];
	/** Ids of the components that render this one. */
	parents: string[];
}

export interface ComponentGraph {
	nodes: GraphNode[];
}
