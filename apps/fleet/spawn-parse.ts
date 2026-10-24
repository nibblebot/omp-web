/**
 * Pure helpers for the fleet's session-spawn surface. No subprocess, no live
 * sessions; the workspace lifecycle imports from here.
 *
 * - Templates are trusted config; `{key}` substitution is plain text
 *   replacement with NO shell escaping. The substituted VALUES are not
 *   trusted (control-plane spawn takes name from HTTP JSON), so any
 *   caller interpolating them into a shell command MUST shell-quote every
 *   value first (see shellQuote; workspace-lifecycle.ts #launchHost does this).
 * - Sessions dial the control plane themselves (callback pair); nothing here
 *   parses a session's stdout for an endpoint.
 */

/**
 * `{key}` substitution for spawn templates. Unknown keys are left verbatim
 * (a missing var is a template bug the caller should surface, not silent
 * data loss).
 *
 * This is PURE text substitution: values are inserted verbatim with no
 * shell escaping. The template itself is trusted config, but the values
 * substituted at runtime may be attacker-controlled (e.g. name from
 * POST /ctl/spawn), so a caller that interpolates the result into a shell
 * command MUST run every value through {@link shellQuote} first;
 * workspace-lifecycle.ts #launchHost does exactly that.
 */
export function fillTemplate(command: string, vars: Record<string, string>): string {
	return command.replace(/\{(\w+)\}/g, (match, key: string) => {
		return key in vars ? vars[key] : match;
	});
}

/**
 * Wrap a value in single quotes for safe insertion into a POSIX shell
 * command, escaping any embedded `'` as `'\''` (close quote, escaped quote,
 * reopen quote). Everything inside single quotes is literal: spaces, `$()`,
 * backticks, `$VAR`, newlines, so this renders attacker-controlled values
 * inert when they end up in a template's `{key}` slot. Pair with
 * fillTemplate: quote first, then substitute.
 */
export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}
