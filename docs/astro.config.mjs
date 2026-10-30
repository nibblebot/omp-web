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
	vite: {
		build: {
			// Mermaid's lazily loaded diagram chunks (see `src/mermaid.ts`) are
			// large by nature; they only load on pages with a diagram.
			chunkSizeWarningLimit: 1500,
		},
	},
	integrations: [
		{
			name: "omp-web-mermaid",
			hooks: {
				// Bundled with the page scripts, so `mermaid` resolves from node_modules.
				"astro:config:setup": ({ injectScript }) => {
					injectScript("page", 'import "/src/mermaid.ts";');
				},
			},
		},
		starlight({
			title: "omp-web",
			description: "Web sessions and fleet management for Oh My Pi.",
			// The mark lives in `src/assets` so Astro hashes it; it reads the same
			// on light and dark, so one logo serves both. `favicon` is a
			// root-relative path into `public/` and Starlight prepends `base`.
			logo: { src: "./src/assets/logo.svg" },
			favicon: "/favicon.svg",
			editLink: {
				baseUrl: "https://github.com/nibblebot/omp-web/edit/main/docs/",
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
					label: "Getting started",
					items: [
						{ label: "Installation", slug: "installation" },
						{ label: "Running omp-web", slug: "running" },
						{ label: "Install as an app", slug: "install-as-an-app" },
					],
				},
				{
					label: "Operations",
					items: [
						{ label: "Reverse proxies and ingress", slug: "reverse-proxies" },
						{ label: "CLI reference", slug: "cli-reference" },
					],
				},
				{
					label: "Configuration",
					items: [
						{ label: "Configuration", slug: "configuration" },
						{ label: "Custom themes", slug: "configuration/custom-themes" },
						{ label: "Optional features", slug: "configuration/features" },
					],
				},
				{
					label: "Reference",
					items: [{ label: "Architecture", slug: "architecture" }],
				},
			],
		}),
	],
});
