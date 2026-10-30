/**
 * The phone hero: the same scripted-journey machinery as hero.ts (recorder.ts, paused page clock,
 * seeded typing), on a Google Pixel 7 (Playwright's `Pixel 7` device: Android Chrome user agent,
 * touch, mobile viewport), so the App takes its phone layout and every input is a touch tap.
 *
 * Journey (demo session `dmn_a002`): the transcript, the sidebar drawer opened and closed on the
 * active session, a prompt typed into the composer and sent, the canned turn streaming, then the
 * Activities panel (full screen on a phone) opened from the header's More actions menu.
 */
import { devices } from "playwright-core";
import { DEFAULT_THEME, newContext, openPage, visible, type Env } from "./browser";
import {
	act,
	createRecorder,
	frameCues,
	frames,
	framesUntil,
	framesWhile,
	keystrokes,
	until,
	type Cue,
} from "./recorder";
import { COMPOSER, SESSION, type Scheme } from "./scenes";

/** The handset: a key of Playwright's `devices`. */
export const PHONE_DEVICE = "Pixel 7";
/**
 * Device pixels per CSS pixel: a whole number. At a fractional scale (1.5) the anti-aliased edges of SVG
 * icons (tool card glyphs, sidebar branch marks) come out one or two levels apart from run to run
 * depending on how Chromium's raster happens to be scheduled, so the decoded frames drifted between
 * processes; whole-number scales repeat exactly.
 */
export const PHONE_SCALE = 2;
/** Width in pixels the 824 px frames are scaled to when encoded: twice the ~300 px the phone shows at in a README column, and a file under the 2.5 MB budget. */
export const PHONE_OUTPUT_WIDTH = 618;

/** The header control the activity buttons collapse into on a phone; its label says activity is running once the session's activity has loaded. */
const MORE = "button[aria-label^='More actions']";
/** The attached session has finished loading its activity: the More actions control carries the running dot. */
const LOADED_ON_PHONE = "button[aria-label='More actions, activity running']";

const PROMPT = "Does it work for inline code too?";
/** Frames held before the first tap, so the loop starts on the idle page. */
const IDLE_BEFORE = 8;
/** Frames the drawer stays up (it lists the fleet's sessions) before the tap on the active row closes it. */
const HOLD_ON_DRAWER = 30;
/** Frames between the drawer closing and the tap on the composer. */
const HOLD_AFTER_DRAWER = 8;
/** Frames between the last key and Send. */
const HOLD_BEFORE_SEND = 10;
/** The canned turn ends well inside this; running past it means the journey is broken. */
const MAX_TURN_FRAMES = 700;
/** Frames between the end of the turn and the tap on More actions. */
const HOLD_AFTER_TURN = 14;
/** Frames the More actions menu stays up. */
const HOLD_ON_MENU = 12;
/** Frames the Subagents popover stays up. */
const HOLD_ON_POPOVER = 14;
/** Frames the panel may take to open and fill. */
const MAX_PANEL_FRAMES = 50;
/** Frames the Activities panel stays up at the end. */
const HOLD_ON_PANEL = 70;

/** Record `dir/f001.png ...` for `scheme`; returns the frame count. */
export async function capturePhoneHero(env: Env, scheme: Scheme, dir: string): Promise<number> {
	const device = devices[PHONE_DEVICE];
	if (device === undefined) throw new Error(`unknown Playwright device: ${PHONE_DEVICE}`);
	const theme = { id: DEFAULT_THEME, scheme };
	const ctx = await newContext(env, {
		viewport: device.viewport,
		scale: PHONE_SCALE,
		device: PHONE_DEVICE,
		theme,
	});
	try {
		const page = await openPage(ctx, `${env.base}${SESSION}`, theme, "paused");
		const rec = createRecorder(page, dir);
		const tap = (selector: string) => () => visible(page, selector).tap();
		await until(page, LOADED_ON_PHONE);
		await until(page, COMPOSER);
		await frames(rec, IDLE_BEFORE);

		await act(page, tap("button[aria-label='Open roster sidebar']"));
		await frames(rec, HOLD_ON_DRAWER);
		await act(page, tap(".roster-row[title='active session']"));
		await frames(rec, HOLD_AFTER_DRAWER);

		const focus: Cue = { at: 0, run: tap(COMPOSER) };
		await frameCues(rec, [focus, ...keystrokes(page, PROMPT)]);
		await frames(rec, HOLD_BEFORE_SEND);
		await act(page, tap("button.send[aria-label='Send']"));

		const stop = visible(page, "button.stop[aria-label='Stop']");
		await framesWhile(
			rec,
			() => stop.isVisible(),
			MAX_TURN_FRAMES,
			"the canned turn never started",
		);
		await framesWhile(
			rec,
			async () => !(await stop.isVisible()),
			MAX_TURN_FRAMES,
			"the canned turn never ran to its end",
		);
		await frames(rec, HOLD_AFTER_TURN);

		await act(page, tap(MORE));
		await frames(rec, HOLD_ON_MENU);
		await act(page, tap(".sidebar-menu-item >> text=Subagents"));
		await frames(rec, HOLD_ON_POPOVER);
		await act(page, tap(".activity-popover-popout"));
		await framesUntil(rec, ".activities-panel", MAX_PANEL_FRAMES);
		await frames(rec, HOLD_ON_PANEL);
		return rec.count;
	} finally {
		await ctx.close();
	}
}
