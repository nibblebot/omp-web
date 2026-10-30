/**
 * The themes grid: the same app view in several built-in themes, tiled in one
 * image. The theme lives in localStorage and same-origin iframes would share it,
 * so each tile is its own browser context; the PNGs are then tiled on a plain
 * local page and that page is screenshotted.
 */
import { BUILTIN_THEMES } from "#lib/themes/builtin";
import { newContext, openPage, quiet, settle, visible, type Env } from "./browser";
import { LOADED, SESSION, VIEWPORTS, type Scheme } from "./scenes";

const COLUMNS = 3;
/** CSS width of one tile; tiles are 1100x700 captures scaled down to it. */
const TILE_WIDTH = 480;
const TILE_HEIGHT = Math.round((TILE_WIDTH * VIEWPORTS.desktop.height) / VIEWPORTS.desktop.width);
const GAP = 14;
const LABEL_HEIGHT = 30;
/** The grid page's own background, in the Catppuccin base of each scheme. */
const PAGE_BG: Record<Scheme, { bg: string; text: string; border: string }> = {
	light: { bg: "#eff1f5", text: "#4c4f69", border: "#ccd0da" },
	dark: { bg: "#1e1e2e", text: "#cdd6f4", border: "#45475a" },
};

/** One theme's app view as PNG bytes. */
async function captureTile(env: Env, id: string, scheme: Scheme): Promise<Buffer> {
	const theme = { id, scheme };
	const ctx = await newContext(env, { viewport: VIEWPORTS.desktop, scale: 1, theme });
	try {
		const page = await openPage(ctx, `${env.base}${SESSION}`, theme, "fixed");
		await visible(page, LOADED).waitFor();
		await page.evaluate(() => document.fonts.ready.then(() => undefined));
		await quiet(page);
		await settle(page);
		return await page.screenshot({ animations: "disabled" });
	} finally {
		await ctx.close();
	}
}

/** Every built-in theme that ships a variant for `scheme`, in the picker's order. */
function themesOf(scheme: Scheme): { id: string; name: string }[] {
	return BUILTIN_THEMES.filter((theme) => theme.variants[scheme] !== undefined).map(
		({ id, name }) => ({ id, name }),
	);
}

/** Render the grid for `scheme` and write the PNG to `png`. */
export async function captureThemesGrid(env: Env, scheme: Scheme, png: string): Promise<void> {
	const themes = themesOf(scheme);
	const tiles = await Promise.all(themes.map(({ id }) => captureTile(env, id, scheme)));
	const colors = PAGE_BG[scheme];
	const cells = themes
		.map(
			({ name }, i) =>
				`<figure><img src="data:image/png;base64,${tiles[i]!.toString("base64")}" width="${TILE_WIDTH}" height="${TILE_HEIGHT}" alt=""><figcaption>${name}</figcaption></figure>`,
		)
		.join("");
	const rows = Math.ceil(themes.length / COLUMNS);
	const width = COLUMNS * TILE_WIDTH + (COLUMNS + 1) * GAP;
	const height = rows * (TILE_HEIGHT + LABEL_HEIGHT) + (rows + 1) * GAP;
	const html = `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;background:${colors.bg};color:${colors.text};font:600 14px "Noto Sans",system-ui,sans-serif}
main{display:grid;grid-template-columns:repeat(${COLUMNS},${TILE_WIDTH}px);gap:${GAP}px;padding:${GAP}px}
figure{margin:0;height:${TILE_HEIGHT + LABEL_HEIGHT}px}
img{display:block;border:1px solid ${colors.border};border-radius:8px;box-sizing:border-box}
figcaption{height:${LABEL_HEIGHT}px;line-height:${LABEL_HEIGHT}px;text-align:center}
</style><main>${cells}</main>`;
	const ctx = await env.browser.newContext({
		viewport: { width, height },
		deviceScaleFactor: 1,
		locale: "en-US",
		timezoneId: "UTC",
		reducedMotion: "reduce",
	});
	try {
		const page = await ctx.newPage();
		await page.setContent(html);
		await page.evaluate(() =>
			Promise.all([...document.images].map((img) => img.decode())).then(() => document.fonts.ready),
		);
		await page.screenshot({ path: png });
	} finally {
		await ctx.close();
	}
}
