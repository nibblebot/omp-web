import { parse } from "@babel/parser";
import type { ParserOptions } from "@babel/parser";
import { isReferenced, traverse } from "@babel/types";
import type { Node, ObjectExpression, Program, SourceLocation } from "@babel/types";
import resolveModule from "enhanced-resolve";
import * as fs from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

type FindingCode =
	| "boundary"
	| "unresolved"
	| "computed"
	| "cycle"
	| "source"
	| "parse"
	| "feature-boundary";
export type LibBoundaryFinding = {
	code: FindingCode;
	file: string;
	line?: number;
	column?: number;
	message: string;
};
/** A finding sink bound to one repository root; both phases report through this shape. */
type FindingReporter = (
	file: string,
	code: FindingCode,
	message: string,
	loc?: SourceLocation | null,
) => void;
type ImportMode = "import" | "require" | "type" | "type-require";
type ModuleReference = {
	specifier: string;
	mode: ImportMode;
	loc?: SourceLocation | null;
	typeDirective?: boolean;
	optional?: boolean;
	/** `import()`: the sanctioned lazy-loader form rather than a static dependency. */
	dynamic?: boolean;
	/** A value import whose named specifiers are all `type`; erased like `import type`. */
	typeOnly?: boolean;
};

const sourceExtension = /\.[cm]?[jt]sx?$/;
const declarationExtension = /\.d\.[cm]?ts$/;

function inside(parent: string, target: string): boolean {
	const path = relative(parent, target);
	return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

function npmPath(path: string): boolean {
	return path.split(sep).includes("node_modules");
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function literal(node: Node | undefined | null): string | undefined {
	if (node?.type === "StringLiteral") return node.value;
	if (node?.type === "TemplateLiteral" && node.expressions.length === 0) {
		return node.quasis[0]?.value.cooked ?? undefined;
	}
	return undefined;
}

function property(node: Node): string | undefined {
	if (node.type !== "MemberExpression" && node.type !== "OptionalMemberExpression") return;
	if (!node.computed && node.property.type === "Identifier") return node.property.name;
	return literal(node.property);
}

function importMeta(node: Node): boolean {
	return (
		node.type === "MetaProperty" && node.meta.name === "import" && node.property.name === "meta"
	);
}

/** All source syntax is inspected, including ambient declarations and test helpers. */
function references(
	file: string,
	text: string,
	finding: (code: FindingCode, message: string, loc?: SourceLocation | null) => void,
): ModuleReference[] {
	const declarations = declarationExtension.test(file);
	const plugins: ParserOptions["plugins"] = [];
	if (/\.[cm]?tsx?$/.test(file)) plugins.push(["typescript", { dts: declarations }]);
	if (/\.[jt]sx$/.test(file)) plugins.push("jsx");
	const ast = parse(text, {
		sourceFilename: file,
		sourceType: "unambiguous",
		createImportExpressions: true,
		attachComment: false,
		plugins,
	});
	const edges: ModuleReference[] = [];
	const factories = new Set<string>();
	const moduleObjects = new Set<string>();
	const loaders = new Set(["require"]);
	const allowedReferences = new Set<Node>();

	/** A literal `module`/`node:module` specifier, however the file reaches it. */
	const builtinModule = (node: Node | undefined | null): boolean => {
		const specifier = literal(node);
		return specifier === "module" || specifier === "node:module";
	};
	const loaderMember = (node: Node): boolean => {
		if (node.type !== "MemberExpression" && node.type !== "OptionalMemberExpression") return false;
		return (
			(node.object.type === "Identifier" && ["module", "globalThis"].includes(node.object.name)) ||
			importMeta(node.object)
		);
	};
	/** `process.getBuiltinModule` reads the same builtin namespaces as `require`. */
	const builtinAccessor = (node: Node): boolean =>
		(node.type === "MemberExpression" || node.type === "OptionalMemberExpression") &&
		node.object.type === "Identifier" &&
		node.object.name === "process" &&
		property(node) === "getBuiltinModule";
	/** Whether an expression evaluates to the `module` builtin namespace. */
	const moduleNamespace = (node: Node | undefined | null): boolean => {
		if (node?.type === "AwaitExpression") return moduleNamespace(node.argument);
		if (node?.type === "Identifier") return moduleObjects.has(node.name);
		if (node?.type === "ImportExpression") return builtinModule(node.source);
		if (node?.type !== "CallExpression" && node?.type !== "OptionalCallExpression") return false;
		if (!builtinModule(node.arguments[0])) return false;
		const callee = node.callee;
		if (callee.type === "Identifier") return loaders.has(callee.name);
		return (
			(callee.type === "MemberExpression" || callee.type === "OptionalMemberExpression") &&
			((loaderMember(callee) && property(callee) === "require") || builtinAccessor(callee))
		);
	};

	traverse(ast, (node) => {
		if (node.type !== "ImportDeclaration" || !builtinModule(node.source)) return;
		for (const specifier of node.specifiers) {
			if (specifier.type !== "ImportSpecifier") {
				moduleObjects.add(specifier.local.name);
			} else if (
				(specifier.imported.type === "Identifier"
					? specifier.imported.name
					: specifier.imported.value) === "createRequire"
			) {
				factories.add(specifier.local.name);
			}
		}
	});

	traverse(ast, (node) => {
		if (node.type !== "VariableDeclarator" || !moduleNamespace(node.init)) return;
		if (node.id.type === "Identifier") {
			moduleObjects.add(node.id.name);
			return;
		}
		if (node.id.type !== "ObjectPattern") return;
		for (const entry of node.id.properties) {
			if (entry.type !== "ObjectProperty") continue;
			const key = entry.key.type === "Identifier" ? entry.key.name : literal(entry.key);
			if (key !== "createRequire") continue;
			const value = entry.value.type === "AssignmentPattern" ? entry.value.left : entry.value;
			if (value.type === "Identifier") factories.add(value.name);
		}
	});

	const factory = (node: Node): boolean => {
		if (node.type === "Identifier") return factories.has(node.name);
		return (
			(node.type === "MemberExpression" || node.type === "OptionalMemberExpression") &&
			property(node) === "createRequire" &&
			moduleNamespace(node.object)
		);
	};
	traverse(ast, (node) => {
		if (
			node.type === "VariableDeclarator" &&
			node.id.type === "Identifier" &&
			node.init?.type === "CallExpression" &&
			factory(node.init.callee)
		) {
			loaders.add(node.id.name);
		}
	});

	const add = (
		node: Node | undefined | null,
		mode: ImportMode,
		loc: SourceLocation | null | undefined,
		options: { includeTypes?: boolean; dynamic?: boolean; typeOnly?: boolean } = {},
	) => {
		const specifier = literal(node);
		if (specifier === undefined) {
			finding(
				"computed",
				"Computed import/require cannot be checked; use a literal module specifier.",
				loc,
			);
		} else {
			const checkedMode = declarations
				? mode === "require" || mode === "type-require"
					? "type-require"
					: "type"
				: mode;
			edges.push({
				specifier,
				mode: checkedMode,
				loc,
				dynamic: options.dynamic || undefined,
				typeOnly: options.typeOnly || undefined,
			});
			if (options.includeTypes && !declarations && (mode === "import" || mode === "require")) {
				edges.push({
					specifier,
					mode: mode === "require" ? "type-require" : "type",
					loc,
					optional: true,
				});
			}
		}
	};
	/** `Bun.resolveSync` exposes the same specifier resolution without loading it. */
	const bunResolver = (node: Node): boolean =>
		(node.type === "MemberExpression" || node.type === "OptionalMemberExpression") &&
		node.object.type === "Identifier" &&
		node.object.name === "Bun" &&
		property(node) === "resolveSync";

	traverse(ast, (node, ancestors) => {
		const parent = ancestors.at(-1)?.node;
		const grandparent = ancestors.at(-2)?.node;
		switch (node.type) {
			case "ImportDeclaration":
				add(
					node.source,
					node.importKind === "type" ||
						(node.specifiers.length > 0 &&
							node.specifiers.every(
								(specifier) =>
									specifier.type === "ImportSpecifier" && specifier.importKind === "type",
							))
						? "type"
						: "import",
					node.loc,
					{ includeTypes: true },
				);
				break;
			case "ExportNamedDeclaration":
			case "ExportAllDeclaration":
				if (node.source) {
					const typeOnly =
						node.type === "ExportNamedDeclaration" &&
						node.specifiers.length > 0 &&
						node.specifiers.every(
							(specifier) =>
								specifier.type === "ExportSpecifier" && specifier.exportKind === "type",
						);
					add(node.source, node.exportKind === "type" ? "type" : "import", node.loc, {
						includeTypes: true,
						typeOnly,
					});
				}
				break;
			case "ImportExpression":
				add(node.source, "import", node.loc, { includeTypes: true, dynamic: true });
				break;
			case "TSImportType":
				add(node.argument, "type", node.loc);
				break;
			case "TSExternalModuleReference":
				add(
					node.expression,
					parent?.type === "TSImportEqualsDeclaration" && parent.importKind === "type"
						? "type-require"
						: "require",
					node.loc,
					{ includeTypes: true },
				);
				break;
			case "TSModuleDeclaration":
				if (node.id.type === "StringLiteral" && !node.id.value.includes("*")) {
					add(node.id, "type", node.loc);
				}
				break;
			case "CallExpression":
			case "OptionalCallExpression": {
				const callee = node.callee;
				if (factory(callee)) {
					allowedReferences.add(callee);
					const base = node.arguments[0];
					if (
						base?.type !== "MemberExpression" ||
						!importMeta(base.object) ||
						property(base) !== "url"
					) {
						finding(
							"computed",
							"createRequire must use import.meta.url so its origin can be checked.",
							node.loc,
						);
					}
					if (
						!(parent?.type === "VariableDeclarator" && parent.id.type === "Identifier") &&
						!(
							(parent?.type === "CallExpression" || parent?.type === "OptionalCallExpression") &&
							parent.callee === node
						)
					) {
						finding("computed", "An escaping createRequire loader cannot be checked.", node.loc);
					}
				} else if (callee.type === "Identifier" && loaders.has(callee.name)) {
					allowedReferences.add(callee);
					add(node.arguments[0], "require", node.loc);
				} else if (callee.type === "CallExpression" && factory(callee.callee)) {
					add(node.arguments[0], "require", node.loc);
				} else if (
					callee.type === "MemberExpression" ||
					callee.type === "OptionalMemberExpression"
				) {
					if (callee.object.type === "Identifier" && loaders.has(callee.object.name)) {
						allowedReferences.add(callee.object);
						if (property(callee) === "resolve") add(node.arguments[0], "require", node.loc);
						else
							finding(
								"computed",
								"Indirect require calls cannot be checked; call the loader directly.",
								node.loc,
							);
					} else if (importMeta(callee.object) && property(callee) === "resolve") {
						add(node.arguments[0], "import", node.loc);
					} else if (builtinAccessor(callee)) {
						add(node.arguments[0], "require", node.loc);
					} else if (bunResolver(callee)) {
						add(node.arguments[0], "require", node.loc);
					} else if (loaderMember(callee)) {
						if (property(callee) === "require") {
							allowedReferences.add(callee);
							add(node.arguments[0], "require", node.loc);
						} else if (callee.computed && property(callee) === undefined) {
							finding("computed", "Computed module-loader access cannot be checked.", node.loc);
						}
					}
				}
				break;
			}
			case "Identifier":
				if (
					(loaders.has(node.name) || factories.has(node.name)) &&
					parent &&
					isReferenced(node, parent, grandparent) &&
					!allowedReferences.has(node)
				) {
					finding("computed", `An escaping ${node.name} reference cannot be checked.`, node.loc);
				}
				break;
			case "MemberExpression":
			case "OptionalMemberExpression":
				if (
					((loaderMember(node) && property(node) === "require") || factory(node)) &&
					!allowedReferences.has(node)
				) {
					finding("computed", "An escaping module-loader reference cannot be checked.", node.loc);
				}
				break;
		}
	});
	for (const comment of ast.comments ?? []) {
		const directive = /^\s*\/\s*<reference\s+(path|types)\s*=\s*(["'])(.*?)\2/.exec(comment.value);
		if (!directive) continue;
		const path = directive[3]!;
		edges.push({
			specifier:
				directive[1] === "path" && !path.startsWith(".") && !isAbsolute(path) ? `./${path}` : path,
			mode: "type",
			typeDirective: directive[1] === "types",
			loc: comment.loc,
		});
	}
	return edges;
}

/** Module resolution matching the bundler: tsconfig aliases, bun/node conditions, TS substitution. */
function moduleResolvers(root: string) {
	const config = join(root, "tsconfig.json");
	const resolver = (mode: ImportMode) => {
		const typed = mode === "type" || mode === "type-require";
		return resolveModule.create.sync({
			fileSystem: fs,
			symlinks: false,
			tsconfig: fs.existsSync(config) ? config : false,
			conditionNames: [
				"bun",
				"node",
				mode === "require" || mode === "type-require" ? "require" : "import",
				...(typed ? ["types"] : []),
			],
			mainFields: typed ? ["types", "typings", "module", "main"] : ["module", "main"],
			extensions: [
				".ts",
				".tsx",
				".mts",
				".cts",
				...(typed ? [".d.ts", ".d.mts", ".d.cts"] : []),
				".js",
				".jsx",
				".mjs",
				".cjs",
				".json",
				".node",
			],
			extensionAlias: {
				".js": [".ts", ".tsx", ...(typed ? [".d.ts"] : []), ".js"],
				".mjs": [".mts", ...(typed ? [".d.mts"] : []), ".mjs"],
				".cjs": [".cts", ...(typed ? [".d.cts"] : []), ".cjs"],
			},
			extensionAliasForExports: true,
		});
	};
	return {
		import: resolver("import"),
		require: resolver("require"),
		type: resolver("type"),
		"type-require": resolver("type-require"),
	};
}

/** Narrow filesystem seam for deterministic checks of real resolved import graphs. */
export function checkLibBoundary(root: string): { files: number; findings: LibBoundaryFinding[] } {
	root = fs.realpathSync(root);
	const lib = join(root, "lib");
	const findings: LibBoundaryFinding[] = [];
	const display = (path: string) => relative(root, path).split(sep).join("/");
	const report = (
		file: string,
		code: FindingCode,
		message: string,
		loc?: SourceLocation | null,
	) => {
		findings.push({
			code,
			file: display(file),
			line: loc?.start.line,
			column: loc ? loc.start.column + 1 : undefined,
			message,
		});
	};
	if (!fs.existsSync(lib)) return { files: 0, findings };
	const files: string[] = [];
	const directories = new Set<string>();
	const sources = new Set<string>();
	const walk = (path: string) => {
		try {
			const real = fs.realpathSync(path);
			if (!inside(lib, real)) {
				report(path, "boundary", `Library source resolves outside lib/: ${display(real)}`);
				return;
			}
			if (fs.statSync(real).isDirectory()) {
				if (directories.has(real)) return;
				directories.add(real);
				for (const name of fs.readdirSync(path).sort()) walk(join(path, name));
			} else if (sourceExtension.test(path) && !sources.has(real)) {
				sources.add(real);
				files.push(real);
			}
		} catch (error) {
			report(path, "source", `Cannot inspect library source: ${errorText(error)}`);
		}
	};
	walk(lib);
	const resolvers = moduleResolvers(root);
	const graph = new Map<
		string,
		Map<string, { file: string; edge: ModuleReference; target: string }>
	>();
	const owner = (file: string) => {
		const path = relative(lib, file).split(sep);
		return path.length > 1 ? path[0]! : "(root)";
	};
	for (const file of files.sort()) {
		let edges: ModuleReference[];
		try {
			edges = references(file, fs.readFileSync(file, "utf8"), (code, message, loc) =>
				report(file, code, message, loc),
			);
		} catch (error) {
			report(file, "parse", `Cannot parse library source: ${errorText(error)}`);
			continue;
		}
		for (const edge of edges) {
			if (
				isBuiltin(edge.specifier) ||
				edge.specifier === "bun" ||
				edge.specifier.startsWith("bun:")
			)
				continue;
			let specifier = edge.specifier;
			try {
				if (specifier.startsWith("file:")) specifier = fileURLToPath(specifier);
				const resolved = resolvers[edge.mode](dirname(file), specifier);
				if (!resolved) throw new Error("No resolved module target");
				const target = fs.realpathSync(resolved.split(/[?#]/, 1)[0]!);
				const packageTarget = npmPath(inside(root, target) ? relative(root, target) : target);
				if (inside(lib, target) && !packageTarget) {
					const from = owner(file);
					const to = owner(target);
					if (from !== to) {
						let dependencies = graph.get(from);
						if (!dependencies) {
							dependencies = new Map();
							graph.set(from, dependencies);
						}
						if (!dependencies.has(to)) dependencies.set(to, { file, edge, target });
					}
				} else if (
					(inside(root, target) && !packageTarget) ||
					(!packageTarget && !npmPath(resolved))
				) {
					report(
						file,
						"boundary",
						`${JSON.stringify(edge.specifier)} resolves outside lib/: ${display(target)}`,
						edge.loc,
					);
				}
			} catch (error) {
				if (edge.optional) continue;
				if (edge.typeDirective) {
					const name = specifier.startsWith("@")
						? specifier.slice(1).replace("/", "__")
						: specifier;
					try {
						const target = resolvers.type(dirname(file), `@types/${name}`);
						if (target && npmPath(fs.realpathSync(target))) continue;
					} catch {
						// Keep the original, actionable unresolved-module diagnostic below.
					}
				}
				report(
					file,
					"unresolved",
					`Cannot resolve ${JSON.stringify(edge.specifier)}: ${errorText(error)}`,
					edge.loc,
				);
			}
		}
	}
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const path: string[] = [];
	const visit = (library: string) => {
		if (visited.has(library)) return;
		visiting.add(library);
		path.push(library);
		for (const [dependency, site] of graph.get(library) ?? []) {
			if (visiting.has(dependency)) {
				const cycle = [...path.slice(path.indexOf(dependency)), dependency];
				const sites = cycle.slice(0, -1).map((from, index) => {
					const edge = graph.get(from)!.get(cycle[index + 1]!)!;
					return `${display(edge.file)}:${edge.edge.loc?.start.line ?? 1} -> ${display(edge.target)}`;
				});
				report(
					site.file,
					"cycle",
					`Cross-library cycle: ${cycle.join(" -> ")} (${sites.join("; ")})`,
					site.edge.loc,
				);
			} else visit(dependency);
		}
		path.pop();
		visiting.delete(library);
		visited.add(library);
	};
	for (const library of [...graph.keys()].sort()) visit(library);
	return { files: files.length, findings };
}

const featureEntryPath = /^apps\/web\/features\/(?<id>[^/\\]+)\.tsx?$/;
/** Directories under the web root that are not core source: shared feature plumbing and tests. */
const webRootExclusions: Readonly<Record<string, true>> = { features: true, test: true };
/** Nested directories are never excluded; the empty table keeps the default allocation-free. */
const noExclusions: Readonly<Record<string, true>> = {};

/** The value of a `name: "value"` property, if the object literal carries one. */
function stringProperty(object: ObjectExpression, name: string): string | undefined {
	for (const property of object.properties) {
		if (property.type !== "ObjectProperty" || property.computed) continue;
		const key = property.key.type === "Identifier" ? property.key.name : literal(property.key);
		if (key === name) return literal(property.value);
	}
	return undefined;
}

/**
 * Feature ids declared by the manifest's `FEATURES` array. The manifest is the
 * only source of truth, so a new feature is covered automatically; an
 * unreadable manifest reports instead of throwing, or the phase would quietly
 * stop enforcing anything.
 */
function manifestFeatureIds(manifest: string, report: FindingReporter): Set<string> {
	const ids = new Set<string>();
	let text: string;
	try {
		text = fs.readFileSync(manifest, "utf8");
	} catch (error) {
		report(manifest, "source", `Cannot read the web feature manifest: ${errorText(error)}`);
		return ids;
	}
	let program: Program;
	try {
		program = parse(text, {
			sourceFilename: manifest,
			sourceType: "unambiguous",
			plugins: [["typescript", { dts: false }]],
		}).program;
	} catch (error) {
		report(manifest, "parse", `Cannot parse the web feature manifest: ${errorText(error)}`);
		return ids;
	}
	let elements: (Node | null)[] | undefined;
	for (const statement of program.body) {
		if (statement.type !== "ExportNamedDeclaration") continue;
		const declaration = statement.declaration;
		if (declaration?.type !== "VariableDeclaration") continue;
		for (const declarator of declaration.declarations) {
			if (declarator.id.type !== "Identifier" || declarator.id.name !== "FEATURES") continue;
			const init = declarator.init;
			const array =
				init?.type === "TSAsExpression" || init?.type === "TSSatisfiesExpression"
					? init.expression
					: init;
			if (array?.type === "ArrayExpression") elements = array.elements;
		}
	}
	let malformed = elements === undefined;
	for (const element of elements ?? []) {
		const id = element?.type === "ObjectExpression" ? stringProperty(element, "id") : undefined;
		if (id === undefined) {
			malformed = true;
			continue;
		}
		ids.add(id);
	}
	if (malformed) {
		report(
			manifest,
			"parse",
			'Cannot read feature ids from FEATURES: every web feature must be an object literal with a string "id"',
		);
	}
	return ids;
}

/**
 * Core web code may import the shared `features/` modules (`manifest`,
 * `registry`, `preferences`, ...), but a feature *entry* must be reached only
 * through the `import()` loaders in `registry.ts`: a static edge from core
 * pulls a disabled feature's JS and CSS into the entry chunk, which is exactly
 * what the lazy registry exists to prevent.
 */
export function checkWebFeatureBoundary(root: string): {
	files: number;
	findings: LibBoundaryFinding[];
} {
	root = fs.realpathSync(root);
	const web = join(root, "apps", "web");
	const findings: LibBoundaryFinding[] = [];
	const display = (path: string) => relative(root, path).split(sep).join("/");
	const report: FindingReporter = (file, code, message, loc) => {
		findings.push({
			code,
			file: display(file),
			line: loc?.start.line,
			column: loc ? loc.start.column + 1 : undefined,
			message,
		});
	};
	if (!fs.existsSync(web)) return { files: 0, findings };
	const ids = manifestFeatureIds(join(web, "features", "manifest.ts"), report);
	const files: string[] = [];
	const directories = new Set<string>();
	const visit = (directory: string, exclusions: Readonly<Record<string, true>> = noExclusions) => {
		let real: string;
		let entries: fs.Dirent[];
		try {
			real = fs.realpathSync(directory);
			if (directories.has(real)) return;
			directories.add(real);
			entries = fs.readdirSync(real, { withFileTypes: true });
		} catch (error) {
			report(directory, "source", `Cannot inspect web source: ${errorText(error)}`);
			return;
		}
		for (const entry of entries) {
			const target = join(real, entry.name);
			if (entry.isDirectory()) {
				if (!Object.hasOwn(exclusions, entry.name)) visit(target);
			} else if (sourceExtension.test(entry.name)) {
				files.push(target);
			}
		}
	};
	visit(web, webRootExclusions);
	const resolvers = moduleResolvers(root);
	for (const file of files.sort()) {
		let edges: ModuleReference[];
		try {
			edges = references(file, fs.readFileSync(file, "utf8"), () => {});
		} catch (error) {
			report(file, "parse", `Cannot parse web source: ${errorText(error)}`);
			continue;
		}
		for (const edge of edges) {
			if (edge.mode !== "import" || edge.dynamic || edge.typeOnly || edge.typeDirective) continue;
			let target: string;
			try {
				let specifier = edge.specifier;
				if (specifier.startsWith("file:")) specifier = fileURLToPath(specifier);
				const resolved = resolvers.import(dirname(file), specifier);
				if (!resolved) continue;
				target = fs.realpathSync(resolved.split(/[?#]/, 1)[0]!);
			} catch {
				// Assets, aliases, and packages cannot be feature entries; only the boundary matters here.
				continue;
			}
			const id = featureEntryPath.exec(display(target))?.groups?.id;
			if (id === undefined || !ids.has(id)) continue;
			report(
				file,
				"feature-boundary",
				`${display(file)} statically imports feature "${id}" via ${JSON.stringify(edge.specifier)} (${display(target)}); load it through import() in apps/web/features/registry.ts instead`,
				edge.loc,
			);
		}
	}
	return { files: files.length, findings };
}

if (import.meta.main) {
	try {
		const root = process.argv[2] ?? resolve(import.meta.dir, "..");
		const library = checkLibBoundary(root);
		const web = checkWebFeatureBoundary(root);
		const findings = [...library.findings, ...web.findings];
		for (const finding of findings) {
			console.error(
				`${finding.file}:${finding.line ?? 1}:${finding.column ?? 1} [${finding.code}] ${finding.message}`,
			);
		}
		if (findings.length > 0) process.exitCode = 1;
		else {
			console.log(
				library.files === 0
					? "Library boundary: lib/ is missing or empty."
					: `Library boundary: ${library.files} source files checked; no outward imports or cross-library cycles.`,
			);
			console.log(
				web.files === 0
					? "Web feature boundary: apps/web is missing or empty."
					: `Web feature boundary: ${web.files} core files checked; no static feature-entry imports.`,
			);
		}
	} catch (error) {
		console.error(`Library boundary: ${errorText(error)}`);
		process.exitCode = 1;
	}
}
