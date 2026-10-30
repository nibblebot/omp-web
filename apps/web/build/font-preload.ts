import type { Plugin } from "vite";

/**
 * Build-only plugin: `<link rel="preload" as="font">` for the emitted font files
 * whose original file name (the basename inside the package) is listed in
 * `files`. The CSS `@font-face` rules reference the fonts, but the browser only
 * learns of them after the stylesheet is fetched and the text that needs them is
 * laid out; the hint lets the fetch start with the HTML. Vite hashes the emitted
 * names, so the hrefs can only be known from the bundle, not written into
 * `index.html`. Fonts are fetched in CORS mode even same-origin, hence
 * `crossorigin`: without it the preload is wasted and the font is fetched twice.
 *
 * A listed file that no emitted asset came from fails the build (a renamed
 * fontsource file or a dropped stylesheet import must not silently lose the hint).
 */
export function fontPreload(options: { files: readonly string[] }): Plugin {
	return {
		name: "omp-font-preload",
		apply: "build",
		transformIndexHtml: {
			order: "post",
			handler(_html, ctx) {
				const bundle = ctx.bundle;
				if (bundle === undefined) return undefined;
				const assets = Object.values(bundle).flatMap((o) => (o.type === "asset" ? [o] : []));
				return options.files.map((file) => {
					const asset = assets.find((a) =>
						a.originalFileNames.some((original) => original.split("/").pop() === file),
					);
					if (asset === undefined) {
						throw new Error(`font-preload: no emitted asset came from ${file}`);
					}
					return {
						tag: "link",
						attrs: {
							rel: "preload",
							as: "font",
							type: "font/woff2",
							crossorigin: "",
							href: `/${asset.fileName}`,
						},
						injectTo: "head" as const,
					};
				});
			},
		},
	};
}
