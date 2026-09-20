// @ts-check

/**
 * Root-relative link rewriting for the deployed site.
 *
 * Astro and Starlight prefix the URLs they generate (routes, sidebar,
 * pagination, bundled assets) with `base`, but links authored in Markdown are
 * emitted verbatim: a Starlight content collection runs no remark/rehype
 * pipeline to hook into. This site is served from `/omp-web/` on GitHub Pages,
 * so authored links such as `/cli/session-daemon/` would escape the
 * project path.
 *
 * The fix is a Sätteri HAST plugin (Sätteri is Astro's default Markdown
 * processor) registered once through `markdown.processor` in
 * `docs/astro.config.mjs`, so every Markdown compile rewrites its URLs instead
 * of every content file spelling out the prefix.
 *
 * Rewrite invariant: a value is prefixed only when it is root-relative, one
 * single leading `/`, and does not already carry the base. Protocol-relative
 * URLs (`//host/path`), fragments (`#section`), scheme URLs (`https:`,
 * `mailto:`), and relative paths are left untouched, and an already-prefixed
 * URL is returned unchanged, so the rewrite is idempotent and equally correct
 * in `astro dev` and `astro build`.
 */

/** URL-bearing attributes this plugin owns, keyed by element name. */
/** @type {Record<string, readonly string[]>} */
const URL_ATTRIBUTES = {
	a: ["href"],
	img: ["src"],
	source: ["src"],
	video: ["src", "poster"],
	audio: ["src"],
	track: ["src"],
	iframe: ["src"],
	embed: ["src"],
};

const TAGS = Object.keys(URL_ATTRIBUTES);

/**
 * Prefix one root-relative URL with `base`.
 *
 * @param {string} value URL attribute value.
 * @param {string} base Base path from the Astro config, e.g. `/omp-web/`.
 * @returns {string} The prefixed URL, or `value` unchanged.
 */
function prefixRootRelative(value, base) {
	if (!value.startsWith("/") || value.startsWith("//")) return value;
	const bareBase = base.replace(/\/$/, "");
	if (bareBase === "" || value === bareBase || value.startsWith(`${bareBase}/`)) return value;
	return `${bareBase}${value}`;
}

/**
 * Sätteri HAST plugin that keeps authored root-relative URLs under `base`.
 *
 * @param {string} base Base path from the Astro config, e.g. `/omp-web/`.
 * @returns {NonNullable<import("@astrojs/markdown-satteri").SatteriProcessorOptions["hastPlugins"]>[number]}
 */
export function baseLinks(base) {
	return {
		name: "omp-web-base-links",
		element: {
			filter: TAGS,
			visit(node, ctx) {
				for (const attribute of URL_ATTRIBUTES[node.tagName] ?? []) {
					const value = node.properties?.[attribute];
					if (typeof value !== "string") continue;
					const rewritten = prefixRootRelative(value, base);
					if (rewritten !== value) ctx.setProperty(node, attribute, rewritten);
				}
			},
		},
	};
}
