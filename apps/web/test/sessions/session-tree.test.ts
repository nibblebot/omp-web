import { describe, expect, test } from "bun:test";
import { activePath, depthIndex } from "../../components/sessions/SessionTreePanel";
import { seedTreeFilter, takeTreeSeed, type GraphNode } from "../../store/graph";

function node(id: string, parentId: string | null, type: GraphNode["type"] = "user"): GraphNode {
	return {
		id,
		parentId,
		type,
		timestamp: "2026-10-16T00:00:00.000Z",
		preview: id,
		hasImages: false,
		childCount: 0,
	};
}

describe("depthIndex", () => {
	test("indents each node by its loaded ancestor count, forking siblings at one depth", () => {
		const depth = depthIndex([
			node("r", null),
			node("a", "r", "assistant"),
			node("b", "a"),
			node("fork", "r", "assistant"),
		]);
		expect(depth.get("r")).toBe(0);
		expect(depth.get("a")).toBe(1);
		expect(depth.get("b")).toBe(2);
		expect(depth.get("fork")).toBe(1);
	});

	test("measures depth relative to the page when a filter drops intermediate parents", () => {
		// "a" was filtered out; "b" is loaded without its parent, so it sits at the top.
		const depth = depthIndex([node("r", null), node("b", "a")]);
		expect(depth.get("r")).toBe(0);
		expect(depth.get("b")).toBe(0);
	});

	test("terminates on a malformed parent cycle", () => {
		const depth = depthIndex([node("x", "y"), node("y", "x")]);
		expect(depth.has("x")).toBe(true);
		expect(depth.has("y")).toBe(true);
	});
});

describe("activePath", () => {
	const nodes = [
		node("r", null),
		node("a", "r", "assistant"),
		node("leaf", "a"),
		node("fork", "r", "assistant"),
	];

	test("lists the leaf and its ancestors up to the root", () => {
		expect([...activePath(nodes, "leaf")].sort()).toEqual(["a", "leaf", "r"]);
	});

	test("is empty without a leaf or when the leaf is not loaded", () => {
		expect(activePath(nodes, null).size).toBe(0);
		expect(activePath(nodes, "missing").size).toBe(0);
	});

	test("stops at the loaded root when an ancestor is not on the page", () => {
		expect([...activePath([node("leaf", "gone")], "leaf")]).toEqual(["leaf"]);
	});
});

describe("tree seed", () => {
	test("a seeded filter is taken once and then cleared", () => {
		seedTreeFilter("fork point");
		expect(takeTreeSeed()).toBe("fork point");
		expect(takeTreeSeed()).toBeNull();
	});
});
