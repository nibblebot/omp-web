import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import { satteri } from "@astrojs/markdown-satteri";
import { baseLinks } from "./src/base-links.mjs";

// GitHub Pages serves this site from `docs/` under the repository path (see
// .github/workflows/pages.yml), so the canonical origin is the user site and
// every internal URL lives under `base`. Astro prefixes the URLs it generates;
// `baseLinks` does the same for links authored in Markdown (see
// `src/base-links.mjs`).
const site = "https://nibblebot.github.io";
const base = "/omp-web/docs/";

export default defineConfig({
	site,
	base,
	markdown: {
		// Astro's default processor is `satteri()`; passing our own keeps those
		// defaults and adds the base-prefix rewrite. Starlight registers its
		// own Markdown plugins on this same processor.
		processor: satteri({ hastPlugins: [baseLinks(base)] }),
	},
	integrations: [
		starlight({
			title: "omp-web",
			description: "Web sessions and fleet management for Oh My Pi.",
			// Marks live in `src/assets` so Astro hashes them; `favicon` is a
			// root-relative path into `public/` and Starlight prepends `base`.
			logo: {
				light: "./src/assets/logo-light.svg",
				dark: "./src/assets/logo-dark.svg",
			},
			favicon: "/favicon.svg",
			editLink: {
				baseUrl: "https://github.com/nibblebot/omp-web/edit/docs/docs/",
			},
			social: [
				{
					icon: "github",
					label: "GitHub",
					href: "https://github.com/nibblebot/omp-web",
				},
			],
			sidebar: [
				{
					label: "Configuration",
					items: [{ label: "Custom themes", slug: "configuration/custom-themes" }],
				},
			],
		}),
	],
});
