/** `index.html` of the output directory: every shot, light beside dark, with what it is meant to show. */
import { existsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SCHEMES, SHOTS } from "./scenes";

function escapeHtml(text: string): string {
	return text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Write `outDir/index.html` for the shots present in `outDir`. */
export function writeContactSheet(outDir: string): void {
	const sections = SHOTS.map((row) => {
		const cells = SCHEMES.map((scheme) => {
			const name = `${row.id}-${scheme}.${row.ext}`;
			if (!existsSync(join(outDir, name)))
				return `<div class="cell absent">${name}: not rendered</div>`;
			const kib = (statSync(join(outDir, name)).size / 1024).toFixed(1);
			return `<figure class="cell ${scheme}"><img src="${name}" loading="lazy" alt="${name}"><figcaption>${name} · ${kib} KiB</figcaption></figure>`;
		}).join("");
		return `<section id="${row.id}"><h2>${row.id}</h2><p>${escapeHtml(row.shows)}</p><div class="pair">${cells}</div></section>`;
	}).join("\n");
	const html = `<!doctype html>
<html lang="en"><meta charset="utf-8"><title>omp-web screenshots</title>
<style>
body{margin:0;padding:24px;font:14px/1.4 system-ui,sans-serif;background:#888;color:#111}
h1{margin:0 0 16px}h2{margin:24px 0 2px;font-size:16px}p{margin:0 0 8px}
.pair{display:grid;grid-template-columns:1fr 1fr;gap:12px;align-items:start}
.cell{margin:0;padding:12px;border-radius:8px;overflow:auto}
.cell.light{background:#fff}.cell.dark{background:#111;color:#eee}.absent{background:#ccc}
img{max-width:100%;height:auto;display:block}
#hero-phone img{max-width:309px}
figcaption{margin-top:6px;font:12px ui-monospace,monospace;opacity:.7}
</style>
<h1>omp-web screenshots</h1>
${sections}
</html>
`;
	writeFileSync(join(outDir, "index.html"), html);
}
