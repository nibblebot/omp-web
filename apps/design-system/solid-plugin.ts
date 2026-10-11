import { type PluginObj, transformAsync, types as t } from "@babel/core";
import { join, relative, sep } from "node:path";

/**
 * Bun plugin that compiles Solid JSX. Bun's built-in JSX transform is
 * React-style and cannot produce Solid's DOM templates, so every .tsx/.jsx
 * module (including `solid`-condition package sources such as
 * @tanstack/solid-virtual) goes through Babel instead.
 *
 * Presets run last to first: TypeScript strips types first, then
 * babel-preset-solid rewrites JSX. Same order vite-plugin-solid uses.
 * Presets are passed as resolved paths: neither ships type declarations.
 *
 * Two hooks feed the component inspector (inspect-runtime.ts):
 * - babel-preset-solid imports its helpers from the runtime (`moduleName`), so
 *   JSX component instances go through the runtime's `createComponent`.
 * - Modules under apps/web/ get a `registerComponent(Local, "<id>")` call per
 *   top-level component declaration, with ids identical to graph.ts node ids.
 */
const presetSolid = Bun.resolveSync("babel-preset-solid", import.meta.dir);
const presetTypescript = Bun.resolveSync("@babel/preset-typescript", import.meta.dir);
const repoRoot = join(import.meta.dir, "..", "..");
const webRoot = join(repoRoot, "apps", "web");
const runtimePath = join(import.meta.dir, "inspect-runtime.ts");

const PASCAL = /^[A-Z][A-Za-z0-9]*$/;
const LOWER = /[a-z]/;

/** Same module filter as graph.ts loadModules, plus the .tsx requirement of graph.ts parseModule. */
function isGraphModule(path: string): boolean {
	const rel = relative(webRoot, path);
	if (rel.startsWith("..") || !rel.endsWith(".tsx")) return false;
	return !rel.split(sep).includes("test") && !/\.(test|d)\.tsx$/.test(rel);
}

/** Same test as graph.ts collectRefs: the function contains JSX somewhere in its body. */
function hasJsx(fn: t.Node): boolean {
	let found = false;
	t.traverseFast(fn, (n) => {
		if (t.isJSXElement(n) || t.isJSXFragment(n)) found = true;
	});
	return found;
}

/**
 * Appends one `registerComponent` call per top-level component declaration of
 * a module. Declaration forms and names mirror graph.ts parseModule: `function X`,
 * `export function X`, `export default function X`, and `X = () => ...` or
 * `X = function () {...}` as a top-level variable, exported or not. Only
 * PascalCase names with a lowercase letter that contain JSX count.
 *
 * Declarations are collected on Program enter, while the JSX still exists (preset-solid
 * removes it during traversal, before Program exit). The import and calls are inserted on
 * Program exit; the import binding is generated so it never collides with user code.
 */
function registrationPlugin(rel: string): PluginObj {
	const names: string[] = [];
	const add = (name: string, fn: t.Node): void => {
		if (PASCAL.test(name) && LOWER.test(name) && hasJsx(fn)) names.push(name);
	};
	const declareVars = (decl: t.Node | null | undefined): void => {
		if (!t.isVariableDeclaration(decl)) return;
		for (const d of decl.declarations) {
			const init = d.init;
			if (
				t.isIdentifier(d.id) &&
				init &&
				(t.isArrowFunctionExpression(init) || t.isFunctionExpression(init))
			) {
				add(d.id.name, init);
			}
		}
	};
	return {
		name: "design-system-register-components",
		visitor: {
			Program: {
				enter(path) {
					for (const stmt of path.node.body) {
						if (t.isFunctionDeclaration(stmt)) {
							if (stmt.id) add(stmt.id.name, stmt);
						} else if (t.isExportDefaultDeclaration(stmt) || t.isExportNamedDeclaration(stmt)) {
							const d = stmt.declaration;
							if (t.isFunctionDeclaration(d)) {
								if (d.id) add(d.id.name, d);
							} else declareVars(d);
						} else declareVars(stmt);
					}
				},
				exit(path) {
					if (names.length === 0) return;
					const register = path.scope.generateUidIdentifier("dsRegister").name;
					path.unshiftContainer(
						"body",
						t.importDeclaration(
							[t.importSpecifier(t.identifier(register), t.identifier("registerComponent"))],
							t.stringLiteral(runtimePath),
						),
					);
					path.pushContainer(
						"body",
						names.map((name) =>
							t.expressionStatement(
								t.callExpression(t.identifier(register), [
									t.identifier(name),
									t.stringLiteral(`${rel}#${name}`),
								]),
							),
						),
					);
				},
			},
		},
	};
}

export const solidPlugin: Bun.BunPlugin = {
	name: "solid-jsx",
	setup(build) {
		build.onLoad({ filter: /\.[jt]sx$/ }, async ({ path }) => {
			const source = await Bun.file(path).text();
			const plugins: PluginObj[] = isGraphModule(path)
				? [registrationPlugin(relative(repoRoot, path).split(sep).join("/"))]
				: [];
			const result = await transformAsync(source, {
				filename: path,
				babelrc: false,
				configFile: false,
				sourceMaps: false,
				plugins,
				presets: [
					[presetSolid, { generate: "dom", hydratable: false, moduleName: runtimePath }],
					...(path.endsWith(".tsx")
						? [
								[
									presetTypescript,
									{ isTSX: true, allExtensions: true, onlyRemoveTypeImports: true },
								],
							]
						: []),
				] as [string, object][],
			});
			if (!result?.code) throw new Error(`solid transform produced no output for ${path}`);
			return { contents: result.code, loader: "js" };
		});
	},
};
