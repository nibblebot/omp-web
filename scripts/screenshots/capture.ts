/** One still: open the scene's page under the determinism recipe, drive it, capture PNG pixels at 2x. */
import type { Page } from "playwright-core";
import {
	DEFAULT_THEME,
	ensureTheme,
	newContext,
	openPage,
	runSteps,
	quiet,
	settle,
	visible,
	type Env,
} from "./browser";
import type { Scheme, StillScene } from "./scenes";
import { VIEWPORTS } from "./scenes";

/** Device pixel ratio of every still. */
export const STILL_SCALE = 2;

/** Story frames in the shot: no tab strip, variant caption, page padding or dashed border; the component sits on the page background. */
const STORY_CHROME_CSS = `
.ds-embed { padding: 0; min-height: 0; }
.ds-tabs, .ds-variant-head, .ds-story-head { display: none !important; }
.ds-variant { margin: 0; }
.ds-variant-body { border: 0; }
`;

/** Open the variant a story scene names: its tab, or, in a stacked story, the one frame of that name. */
async function openVariant(page: Page, scene: StillScene, variant: string): Promise<void> {
	if ((await page.getByRole("tab").count()) > 0) {
		// Dispatched, not pointer-clicked: a modal story's backdrop covers the tab strip.
		await page.getByRole("tab", { name: variant, exact: true }).dispatchEvent("click");
		return;
	}
	const kept = await page.evaluate((name) => {
		let found = 0;
		for (const frame of document.querySelectorAll<HTMLElement>(".ds-variant")) {
			const own = frame.querySelector(".ds-variant-name")?.textContent === name;
			frame.style.display = own ? "" : "none";
			if (own) found++;
		}
		return found;
	}, variant);
	if (kept !== 1) throw new Error(`${scene.id}: ${kept} variants named "${variant}"`);
}

/** The page rectangle (CSS px) a clip names: a rectangle as given, or an element's box grown by `pad`. */
async function clipRect(
	page: Page,
	clip: NonNullable<StillScene["clip"]>,
): Promise<{ x: number; y: number; width: number; height: number }> {
	if (!("selector" in clip)) return clip;
	const target = visible(page, clip.selector);
	await target.waitFor({ state: "visible" });
	const box = await target.boundingBox();
	if (box === null) throw new Error(`clip ${clip.selector} has no box`);
	const pad = clip.pad ?? 0;
	const x = Math.max(0, box.x - pad);
	const y = Math.max(0, box.y - pad);
	return {
		x,
		y,
		width: box.width + 2 * pad - (x - (box.x - pad)),
		height: box.height + 2 * pad - (y - (box.y - pad)),
	};
}

/** Render `scene` in `scheme` and write the PNG to `png`. */
export async function captureStill(
	env: Env,
	scene: StillScene,
	scheme: Scheme,
	png: string,
): Promise<void> {
	const theme = { id: DEFAULT_THEME, scheme };
	const ctx = await newContext(env, {
		viewport: VIEWPORTS[scene.viewport],
		scale: STILL_SCALE,
		touch: scene.viewport === "phone",
		theme,
	});
	try {
		const { source } = scene;
		const url =
			source.kind === "story"
				? `${env.base}?embed=${encodeURIComponent(source.story)}`
				: `${env.base}${source.route}`;
		const page = await openPage(ctx, url, theme, "fixed");
		if (source.kind === "story") {
			if (source.variant !== undefined) await openVariant(page, scene, source.variant);
			await page.addStyleTag({ content: STORY_CHROME_CSS });
			if (scene.frameWidth !== undefined) {
				await page.addStyleTag({
					content: `.ds-variant-body { box-sizing: border-box; width: ${scene.frameWidth}px; }`,
				});
			}
			// A story seed may store another theme mode (opening a variant re-runs it).
			await ensureTheme(page, theme);
		}
		if (source.steps !== undefined) await runSteps(page, source.steps);
		for (const selector of scene.ready) await visible(page, selector).waitFor();
		if (scene.until !== undefined) await page.waitForFunction(scene.until);
		await page.evaluate(() => document.fonts.ready.then(() => undefined));
		await quiet(page);
		await settle(page);
		if ((await page.locator(".ds-error").count()) > 0) {
			throw new Error(`${scene.id}: the page shows a story error (.ds-error)`);
		}
		await page.screenshot({
			path: png,
			animations: "disabled",
			...(scene.clip === undefined
				? {}
				: { clip: await clipRect(page, scene.clip), fullPage: true }),
		});
	} finally {
		await ctx.close();
	}
}
