import { join } from "node:path";
import { computeGraph } from "./graph";

const storiesDir = join(import.meta.dir, "stories");

/**
 * Build-time virtual modules, recomputed on every Bun.build (so one page load
 * sees fresh sources):
 *  - `ds:graph`   default export: the ComponentGraph of apps/web (graph.ts)
 *  - `ds:stories` default export: every stories/**\/*.tsx default export, flattened
 *    (stories/ mirrors apps/web/components: stories/chat/tools/... and so on)
 * Typed in virtual.d.ts.
 */
export function virtualModulesPlugin(): Bun.BunPlugin {
	return {
		name: "design-system-virtual-modules",
		setup(build) {
			build.onResolve({ filter: /^ds:/ }, ({ path }) => ({ path, namespace: "ds" }));
			build.onLoad({ filter: /^ds:graph$/, namespace: "ds" }, async () => ({
				contents: `export default ${JSON.stringify(await computeGraph())};`,
				loader: "js",
			}));
			build.onLoad({ filter: /^ds:stories$/, namespace: "ds" }, async () => {
				const files: string[] = [];
				for await (const name of new Bun.Glob("**/*.tsx").scan({ cwd: storiesDir })) {
					files.push(join(storiesDir, name));
				}
				files.sort();
				const imports = files.map((file, i) => `import s${i} from ${JSON.stringify(file)};`);
				const list = files.map((_, i) => `s${i}`).join(", ");
				return {
					contents: `${imports.join("\n")}\nexport default [${list}].flat();`,
					loader: "js",
				};
			});
		},
	};
}
