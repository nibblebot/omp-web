/** Computed-style properties that affect how a textarea lays out and wraps text. */
const MIRRORED_STYLES = [
	"fontFamily",
	"fontSize",
	"fontWeight",
	"fontStyle",
	"fontVariant",
	"fontStretch",
	"lineHeight",
	"letterSpacing",
	"wordSpacing",
	"textTransform",
	"textIndent",
	"tabSize",
	"wordBreak",
	"direction",
	"paddingTop",
	"paddingRight",
	"paddingBottom",
	"paddingLeft",
] as const;

/**
 * True when the caret sits on the textarea's top VISUAL row: no preceding
 * newline and no soft wrap between the start of the text and the caret.
 * The caret is the focus end of the selection.
 *
 * Newline-free and empty prefixes are answered without layout. Otherwise a
 * hidden mirror div with the textarea's text metrics and content width holds
 * the text before the caret, then a marker span holding the rest of the text
 * (so the word at the caret wraps exactly as in the textarea, and the marker
 * starts where the caret renders). The caret is on the first row when the
 * marker shares the top of an empty reference span placed at the very start.
 */
export function caretOnFirstRow(el: HTMLTextAreaElement): boolean {
	const caret = el.selectionDirection === "backward" ? el.selectionStart : el.selectionEnd;
	const before = el.value.slice(0, caret);
	if (before.includes("\n")) return false;
	if (before === "") return true;

	const cs = getComputedStyle(el);
	const mirror = document.createElement("div");
	const s = mirror.style;
	s.setProperty("position", "absolute");
	s.setProperty("visibility", "hidden");
	s.setProperty("top", "0");
	s.setProperty("left", "-9999px");
	s.setProperty("overflow", "hidden");
	s.setProperty("height", "auto");
	// Textareas always wrap as pre-wrap regardless of the computed value.
	s.setProperty("white-space", "pre-wrap");
	s.setProperty("overflow-wrap", "break-word");
	s.setProperty("box-sizing", "content-box");
	s.setProperty("border", "0");
	for (const prop of MIRRORED_STYLES) s[prop] = cs[prop];
	// clientWidth excludes the scrollbar, so wrapping matches the textarea.
	const contentWidth =
		el.clientWidth -
		(Number.parseFloat(cs.paddingLeft) || 0) -
		(Number.parseFloat(cs.paddingRight) || 0);
	s.setProperty("width", `${Math.max(0, contentWidth)}px`);

	const ref = document.createElement("span");
	const marker = document.createElement("span");
	marker.textContent = el.value.slice(caret);
	mirror.append(ref, document.createTextNode(before), marker);

	document.body.appendChild(mirror);
	try {
		return marker.offsetTop - ref.offsetTop < Math.max(1, ref.offsetHeight / 2);
	} finally {
		mirror.remove();
	}
}
