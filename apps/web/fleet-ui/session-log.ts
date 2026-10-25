// ---------------------------------------------------------------------------
// Session process log view (SessionLog) helpers: pure logic, no JSX, no Solid.
// The stderr tail is a plain string; the view filters it to triage lines and
// follows the newest line. Kept here so the filter is testable without a DOM.
// ---------------------------------------------------------------------------

/** Lines that matter when triaging a session process: errors, warnings, failures. */
const TRIAGE_LINE = /\b(error|warn|warning|fail|failed|panic|fatal|exception)\b/i;

/** The stderr tail verbatim, or with only the triage lines when `errorsOnly`. */
export function filterStderr(text: string, errorsOnly: boolean): string {
	if (!errorsOnly) return text;
	return text
		.split("\n")
		.filter((line) => TRIAGE_LINE.test(line))
		.join("\n");
}
