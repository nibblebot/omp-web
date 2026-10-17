import type { OmpSetupStatus } from "#lib/wire/protocol";

/** One status line for the first-run sign-in step: omp install, provider
 *  sign-in, and default model. Pure so the wording is unit-tested. */
export function ompSetupSummary(s: OmpSetupStatus): string {
	const install = s.ompInstalled ? "omp found" : "omp not found on PATH, install omp and re-check";
	const auth =
		s.providers.length > 0 ? `signed in: ${s.providers.join(", ")}` : "no provider signed in yet";
	const model = s.defaultModel ? `default model ${s.defaultModel}` : "no default model set";
	return [install, auth, model].join(" · ");
}
