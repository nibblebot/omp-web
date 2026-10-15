import { settingValue } from "../../store/settings";

/**
 * A card-form session title, `<icon> <CODE>: <title>` (the SDK's card form in
 * `utils/title-card.ts`). The icon is an emoji or a Nerd Fonts glyph.
 */
const CARD_TITLE = /^(\S+) ([A-Z0-9]{1,6}): (\S.*)$/u;
/** An emoji icon. Any other card icon is a Nerd Fonts glyph, which the web cannot draw. */
const EMOJI_ICON = /\p{Extended_Pictographic}/u;

/**
 * A session title as the web shows it, honoring `title.icons`. `boring` drops
 * the card (icon and code) to the plain title. Under `nf+emoji` and `emoji` the
 * card keeps an emoji icon; the web bundles no Nerd Font, so a Nerd Fonts glyph
 * is dropped and the code stays. Nullish titles pass through as `undefined`, so
 * callers keep their `??` fallbacks.
 */
export function displayTitle(title: string | null | undefined): string | undefined {
	if (title === null || title === undefined) return undefined;
	const card = CARD_TITLE.exec(title);
	if (!card) return title;
	const [, icon, code, rest] = card;
	if (settingValue<string>("title.icons") === "boring") return rest;
	if (EMOJI_ICON.test(icon)) return title;
	return `${code}: ${rest}`;
}
