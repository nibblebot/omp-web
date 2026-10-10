/** Build-time virtual modules provided by virtual-modules.ts. */
declare module "ds:graph" {
	import type { ComponentGraph } from "./graph-types";
	const graph: ComponentGraph;
	export default graph;
}

declare module "ds:stories" {
	import type { Story } from "./registry";
	const stories: Story[];
	export default stories;
}
