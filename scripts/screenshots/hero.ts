/**
 * The hero animation: one scripted journey through the demo App, recorded as
 * frames by recorder.ts under a paused page clock.
 *
 * Journey (demo session `dmn_a002`): type a prompt with an `@` file mention,
 * send it, watch the canned turn stream with tool cards, then open the
 * Activities dock beside the transcript.
 */
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
import { COMPOSER, LOADED, SESSION, VIEWPORTS, type Scheme } from "./scenes";

/** What the user types: the `@` mention opens the file completer, which the user then accepts with Tab. */
const PROMPT = "Add a copy button to code fences, starting from @apps/web/comp";
/** Frames held before the click, so the loop starts on the idle page. */
const IDLE_BEFORE = 8;
/** Longest wait for the completer popup after the last key (it debounces 150 ms); a miss means the journey is broken. */
const MAX_POPUP_FRAMES = 50;
/** Frames the popup stays up before it is accepted. */
const HOLD_ON_POPUP = 20;
/** Frames between accepting the mention and sending. */
const HOLD_BEFORE_SEND = 8;
/** Frames between the end of the turn and Alt+A. */
const HOLD_AFTER_TURN = 16;
/** Frames the Activities panel stays up at the end: long enough to read the subagent row. */
const HOLD_ON_DOCK = 60;
/** The canned turn ends well inside this; running past it means the journey is broken. */
const MAX_TURN_FRAMES = 700;
/** Frames the dock may take to open and fill. */
const MAX_DOCK_FRAMES = 50;

/** Record `dir/f001.png ...` for `scheme`; returns the frame count. */
export async function captureHero(env: Env, scheme: Scheme, dir: string): Promise<number> {
	const theme = { id: DEFAULT_THEME, scheme };
	const ctx = await newContext(env, { viewport: VIEWPORTS.desktop, scale: 1, theme });
	try {
		const page = await openPage(ctx, `${env.base}${SESSION}`, theme, "paused");
		const rec = createRecorder(page, dir);
		await until(page, LOADED);
		await until(page, COMPOSER);
		await frames(rec, IDLE_BEFORE);

		const focus: Cue = { at: 0, run: () => visible(page, COMPOSER).click() };
		await frameCues(rec, [focus, ...keystrokes(page, PROMPT)]);
		await framesUntil(rec, ".autocomplete-row", MAX_POPUP_FRAMES);
		await frames(rec, HOLD_ON_POPUP);
		await act(page, () => page.keyboard.press("Tab"));
		await frames(rec, HOLD_BEFORE_SEND);
		await act(page, () => visible(page, "button.send[aria-label='Send']").click());

		// The turn runs while the Stop button is up: wait for it to appear, then to go.
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

		await act(page, () => page.keyboard.press("Alt+a"));
		await framesUntil(rec, "text=FenceCallers", MAX_DOCK_FRAMES);
		await frames(rec, HOLD_ON_DOCK);
		return rec.count;
	} finally {
		await ctx.close();
	}
}
