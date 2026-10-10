import { transformAsync } from "@babel/core";

/**
 * Bun plugin that compiles Solid JSX. Bun's built-in JSX transform is
 * React-style and cannot produce Solid's DOM templates, so every .tsx/.jsx
 * module (including `solid`-condition package sources such as
 * @tanstack/solid-virtual) goes through Babel instead.
 *
 * Presets run last to first: TypeScript strips types first, then
 * babel-preset-solid rewrites JSX. Same order vite-plugin-solid uses.
 * Presets are passed as resolved paths: neither ships type declarations.
 */
const presetSolid = Bun.resolveSync("babel-preset-solid", import.meta.dir);
const presetTypescript = Bun.resolveSync("@babel/preset-typescript", import.meta.dir);

export const solidPlugin: Bun.BunPlugin = {
	name: "solid-jsx",
	setup(build) {
		build.onLoad({ filter: /\.[jt]sx$/ }, async ({ path }) => {
			const source = await Bun.file(path).text();
			const result = await transformAsync(source, {
				filename: path,
				babelrc: false,
				configFile: false,
				sourceMaps: false,
				presets: [
					[presetSolid, { generate: "dom", hydratable: false }],
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
