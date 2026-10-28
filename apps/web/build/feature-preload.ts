import type { Plugin } from "vite";
import { FEATURES_KEY } from "../features/preferences.ts";
import { FEATURES } from "../features/manifest.ts";
import { DEFAULT_FEATURES_DIR, featureOfEntry, reach } from "./feature-sizes.ts";

/**
 * Build-only plugin: lets the browser fetch the entry modules of the features
 * that default to on (and their CSS) in parallel with the app entry, instead
 * of one round trip after it. The app renders without waiting for them (their
 * slots fill in when `activateFeatures` resolves), so this only shortens the
 * time until those slots fill.
 *
 * The hints are created by a small inline script, not static `<link>` tags,
 * because a user who turned a feature off must not fetch its chunk: the script
 * skips every feature whose stored choice (`omp.features`, preferences.ts) is
 * `false`. A feature that is in development, or off by default, is never hinted.
 */
export function featurePreload(): Plugin {
	return {
		name: "omp-feature-preload",
		apply: "build",
		transformIndexHtml: {
			order: "post",
			handler(_html, ctx) {
				const bundle = ctx.bundle;
				if (bundle === undefined) return undefined;
				const entries = Object.values(bundle).flatMap((o) =>
					o.type === "chunk" && o.isEntry ? [o.fileName] : [],
				);
				const entryStatic = reach(bundle, entries, new Set(), false);
				const hinted = new Set(
					FEATURES.filter((f) => f.defaultEnabled && f.status !== "in-development").map(
						(f) => f.id,
					),
				);
				const chunks: Record<string, { js: string[]; css: string[] }> = {};
				for (const output of Object.values(bundle)) {
					if (output.type !== "chunk") continue;
					const id = featureOfEntry(output.facadeModuleId, DEFAULT_FEATURES_DIR);
					if (id === undefined || !hinted.has(id)) continue;
					const owned = [...reach(bundle, [output.fileName], entryStatic, false)];
					chunks[id] = {
						js: owned.filter((file) => file.endsWith(".js")).map((file) => `/${file}`),
						css: owned.filter((file) => file.endsWith(".css")).map((file) => `/${file}`),
					};
				}
				if (Object.keys(chunks).length === 0) return undefined;
				const script = `(function(){var c=${JSON.stringify(chunks)},off={};try{off=JSON.parse(localStorage.getItem(${JSON.stringify(FEATURES_KEY)}))||{}}catch(e){}for(var id in c){if(off[id]===false)continue;var add=function(rel,href,as){var l=document.createElement("link");l.rel=rel;l.crossOrigin="";if(as)l.as=as;l.href=href;document.head.appendChild(l)};c[id].js.forEach(function(h){add("modulepreload",h)});c[id].css.forEach(function(h){add("preload",h,"style")})}})();`;
				return [{ tag: "script", children: script, injectTo: "head-prepend" }];
			},
		},
	};
}
