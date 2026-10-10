import { parse } from "@babel/parser";
import type { Node } from "@babel/types";
import { existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ComponentGraph, GraphNode } from "./graph-types";

/**
 * Component render graph for apps/web, computed from source with Babel.
 *
 * A component is a top-level PascalCase function or function-valued const
 * whose body contains JSX. Its children are the project components named by
 * the JSX inside it (nested inline components included: they are shown via
 * their parent). JSX names resolve through imports, barrel re-exports
 * (`export { X } from`, `export *`), namespace imports (`<Ns.X />`), and
 * same-file declarations; `<Dynamic component={X} />` counts as rendering X.
 * Tier is 0 for leaves, else 1 + the highest child tier.
 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const webRoot = join(repoRoot, "apps", "web");

type JsxRef = { object: string | null; name: string };
type ImportBinding = { file: string | null; imported: string };
type ExportTarget =
	| { kind: "local"; local: string }
	| { kind: "reexport"; file: string | null; name: string };
interface Decl {
	name: string;
	line: number;
	refs: JsxRef[];
}
interface Module {
	rel: string;
	/** Module-level `const X = { key: Component, ... }` lookup tables (names of the values). */
	maps: Map<string, string[]>;
	imports: Map<string, ImportBinding>;
	decls: Map<string, Decl>;
	exports: Map<string, ExportTarget>;
	stars: Array<string | null>;
}

const PASCAL = /^[A-Z][A-Za-z0-9]*$/;
const LOWER = /[a-z]/;

function isComponentName(name: string): boolean {
	return PASCAL.test(name) && LOWER.test(name);
}

/** Visit every AST node below `root` (the nodes themselves, not comments or locations). */
function walk(root: unknown, visit: (node: Node) => void): void {
	if (Array.isArray(root)) {
		for (const item of root) walk(item, visit);
		return;
	}
	if (typeof root !== "object" || root === null) return;
	const node = root as Record<string, unknown>;
	if (typeof node.type === "string") visit(node as unknown as Node);
	for (const key of Object.keys(node)) {
		if (key === "loc" || key.endsWith("Comments") || key === "extra") continue;
		walk(node[key], visit);
	}
}

/** JSX element names (and `Dynamic component={X}`) used anywhere inside a function. */
function collectRefs(fn: Node): JsxRef[] | null {
	const refs: JsxRef[] = [];
	let hasJsx = false;
	walk(fn, (n) => {
		if (n.type === "JSXElement" || n.type === "JSXFragment") hasJsx = true;
		if (n.type === "JSXOpeningElement") {
			const nm = n.name;
			if (nm.type === "JSXIdentifier") {
				if (/^[A-Z]/.test(nm.name)) refs.push({ object: null, name: nm.name });
			} else if (nm.type === "JSXMemberExpression" && nm.object.type === "JSXIdentifier") {
				refs.push({ object: nm.object.name, name: nm.property.name });
			}
		}
		// <Dynamic component={MAP[key] ?? Fallback} />: every identifier in the
		// expression may be a component, or a lookup table of components.
		if (
			n.type === "JSXAttribute" &&
			n.name.type === "JSXIdentifier" &&
			n.name.name === "component" &&
			n.value?.type === "JSXExpressionContainer"
		) {
			walk(n.value.expression, (inner) => {
				if (inner.type === "Identifier") refs.push({ object: null, name: inner.name });
			});
		}
	});
	return hasJsx ? refs : null;
}

function resolveFile(fromFile: string, specifier: string): string | null {
	if (!specifier.startsWith(".")) return null;
	const base = resolve(dirname(fromFile), specifier);
	for (const candidate of [
		`${base}.tsx`,
		`${base}.ts`,
		join(base, "index.tsx"),
		join(base, "index.ts"),
	]) {
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

function exportedName(node: { type: string; name?: string; value?: string }): string {
	return (node.type === "StringLiteral" ? node.value : node.name) ?? "";
}

function parseModule(file: string, source: string): Module {
	const ast = parse(source, {
		sourceType: "module",
		plugins: file.endsWith(".tsx") ? ["typescript", "jsx"] : ["typescript"],
	});
	const mod: Module = {
		rel: relative(repoRoot, file),
		maps: new Map(),
		imports: new Map(),
		decls: new Map(),
		exports: new Map(),
		stars: [],
	};
	const declare = (name: string, fn: Node, line: number): void => {
		if (!isComponentName(name) || !file.endsWith(".tsx")) return;
		const refs = collectRefs(fn);
		if (refs) mod.decls.set(name, { name, line, refs });
	};
	const declareVar = (decl: Node): void => {
		if (decl.type !== "VariableDeclaration") return;
		for (const d of decl.declarations) {
			if (d.id.type !== "Identifier" || !d.init) continue;
			let init: Node = d.init;
			while (
				init.type === "TSAsExpression" ||
				init.type === "TSSatisfiesExpression" ||
				init.type === "TSNonNullExpression"
			) {
				init = init.expression;
			}
			if (init.type === "ObjectExpression") {
				const values: string[] = [];
				for (const prop of init.properties) {
					if (prop.type === "ObjectProperty" && prop.value.type === "Identifier") {
						values.push(prop.value.name);
					}
				}
				if (values.length > 0) mod.maps.set(d.id.name, values);
			}
			if (d.init.type === "ArrowFunctionExpression" || d.init.type === "FunctionExpression") {
				declare(d.id.name, d.init, d.loc?.start.line ?? 0);
			}
		}
	};
	for (const stmt of ast.program.body) {
		if (stmt.type === "ImportDeclaration") {
			if (stmt.importKind === "type") continue;
			const target = resolveFile(file, stmt.source.value);
			for (const spec of stmt.specifiers) {
				if (spec.type === "ImportSpecifier") {
					if (spec.importKind === "type") continue;
					mod.imports.set(spec.local.name, { file: target, imported: exportedName(spec.imported) });
				} else if (spec.type === "ImportDefaultSpecifier") {
					mod.imports.set(spec.local.name, { file: target, imported: "default" });
				} else {
					mod.imports.set(spec.local.name, { file: target, imported: "*" });
				}
			}
			continue;
		}
		if (stmt.type === "ExportAllDeclaration") {
			if (stmt.exportKind !== "type") mod.stars.push(resolveFile(file, stmt.source.value));
			continue;
		}
		if (stmt.type === "ExportDefaultDeclaration") {
			const d = stmt.declaration;
			if (d.type === "FunctionDeclaration" && d.id) {
				declare(d.id.name, d, d.loc?.start.line ?? 0);
				mod.exports.set("default", { kind: "local", local: d.id.name });
			} else if (d.type === "Identifier") {
				mod.exports.set("default", { kind: "local", local: d.name });
			}
			continue;
		}
		if (stmt.type === "ExportNamedDeclaration") {
			if (stmt.exportKind === "type") continue;
			const d = stmt.declaration;
			if (d) {
				if (d.type === "FunctionDeclaration" && d.id) {
					declare(d.id.name, d, d.loc?.start.line ?? 0);
					mod.exports.set(d.id.name, { kind: "local", local: d.id.name });
				} else if (d.type === "VariableDeclaration") {
					declareVar(d);
					for (const v of d.declarations) {
						if (v.id.type === "Identifier") {
							mod.exports.set(v.id.name, { kind: "local", local: v.id.name });
						}
					}
				}
				continue;
			}
			const target = stmt.source ? resolveFile(file, stmt.source.value) : undefined;
			for (const spec of stmt.specifiers) {
				if (spec.type !== "ExportSpecifier" || spec.exportKind === "type") continue;
				const as = exportedName(spec.exported);
				mod.exports.set(
					as,
					stmt.source
						? { kind: "reexport", file: target ?? null, name: exportedName(spec.local) }
						: { kind: "local", local: exportedName(spec.local) },
				);
			}
			continue;
		}
		if (stmt.type === "FunctionDeclaration" && stmt.id) {
			declare(stmt.id.name, stmt, stmt.loc?.start.line ?? 0);
		} else {
			declareVar(stmt);
		}
	}
	return mod;
}

/**
 * Folder group, matching the source tree: the directory under
 * apps/web/components ("chat/tools", "fleet/sidebar"), "tx" plus its folder
 * under tx/components ("tx/transcript/rows"), or "app" for root files
 * (App.tsx, ModalHost.tsx).
 */
function groupOf(rel: string): string {
	const dirs = rel.split("/").slice(2, -1); // drop apps/web and the file name
	if (dirs[0] === "components" && dirs.length > 1) return dirs.slice(1).join("/");
	if (dirs[0] === "tx") return ["tx", ...dirs.slice(dirs[1] === "components" ? 2 : 1)].join("/");
	return dirs.length > 0 ? dirs.join("/") : "app";
}

async function loadModules(): Promise<Map<string, Module>> {
	const modules = new Map<string, Module>();
	const glob = new Bun.Glob("**/*.{ts,tsx}");
	for await (const path of glob.scan({ cwd: webRoot })) {
		if (path.split("/").includes("test") || /\.(test|d)\.[tj]sx?$/.test(path)) continue;
		if (path === "vite.config.ts") continue;
		const file = join(webRoot, path);
		modules.set(file, parseModule(file, await Bun.file(file).text()));
	}
	return modules;
}

export async function computeGraph(): Promise<ComponentGraph> {
	const modules = await loadModules();

	// Resolution yields component ids: one for a component, several for a lookup
	// table of components (`RENDERERS`), none for anything else.
	const resolveExport = (file: string, name: string, seen = new Set<string>()): string[] => {
		const key = `${file}\0${name}`;
		if (seen.has(key)) return [];
		seen.add(key);
		const mod = modules.get(file);
		if (!mod) return [];
		const entry = mod.exports.get(name);
		if (entry?.kind === "local") return resolveLocal(mod, entry.local, seen);
		if (entry?.kind === "reexport") {
			return entry.file ? resolveExport(entry.file, entry.name, seen) : [];
		}
		if (name === "default") return [];
		for (const star of mod.stars) {
			const found = star ? resolveExport(star, name, seen) : [];
			if (found.length > 0) return found;
		}
		return [];
	};
	const resolveLocal = (mod: Module, local: string, seen: Set<string>): string[] => {
		if (mod.decls.has(local)) return [`${mod.rel}#${local}`];
		const table = mod.maps.get(local);
		if (table) return table.flatMap((value) => resolveLocal(mod, value, seen));
		const imp = mod.imports.get(local);
		return imp?.file && imp.imported !== "*" ? resolveExport(imp.file, imp.imported, seen) : [];
	};

	const nodes = new Map<string, GraphNode>();
	for (const mod of modules.values()) {
		for (const decl of mod.decls.values()) {
			const children = new Set<string>();
			for (const ref of decl.refs) {
				let targets: string[] = [];
				if (ref.object === null) {
					targets = resolveLocal(mod, ref.name, new Set());
				} else {
					const ns = mod.imports.get(ref.object);
					if (ns?.file && ns.imported === "*") targets = resolveExport(ns.file, ref.name);
				}
				for (const target of targets) children.add(target);
			}
			const id = `${mod.rel}#${decl.name}`;
			children.delete(id);
			const exportNames = [...mod.exports]
				.filter(([, t]) => t.kind === "local" && t.local === decl.name)
				.map(([n]) => n);
			nodes.set(id, {
				id,
				name: decl.name,
				file: mod.rel,
				line: decl.line,
				exportNames,
				group: groupOf(mod.rel),
				tier: 0,
				children: [...children],
				parents: [],
			});
		}
	}

	const state = new Map<string, "visiting" | "done">();
	const tierOf = (id: string): number => {
		const node = nodes.get(id);
		if (!node) return -1;
		if (state.get(id) === "visiting") return -1; // render cycle: ignore the back edge
		if (state.get(id) === "done") return node.tier;
		state.set(id, "visiting");
		let tier = 0;
		for (const child of node.children) tier = Math.max(tier, tierOf(child) + 1);
		node.tier = tier;
		state.set(id, "done");
		return tier;
	};
	for (const id of nodes.keys()) tierOf(id);
	for (const node of nodes.values()) {
		for (const child of node.children) nodes.get(child)?.parents.push(node.id);
	}

	return {
		nodes: [...nodes.values()].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line),
	};
}

if (import.meta.main) {
	const graph = await computeGraph();
	if (process.argv.includes("--json")) {
		console.log(JSON.stringify(graph, null, 2));
	} else {
		const counts = new Map<number, number>();
		for (const n of graph.nodes) counts.set(n.tier, (counts.get(n.tier) ?? 0) + 1);
		console.log(`${graph.nodes.length} components`);
		for (const [tier, count] of [...counts].sort(([a], [b]) => a - b)) {
			console.log(`tier ${tier}: ${count}`);
		}
	}
}
