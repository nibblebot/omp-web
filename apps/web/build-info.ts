/**
 * Build identity shown in the sidebar footer. Stamped by `define` from
 * build/build-info.ts (vite.config.ts, design-system server); undeclared
 * under `bun test`, where `typeof` on the missing identifier yields
 * "undefined" without throwing and the field reads as "" (not shown).
 */

declare const __OMP_WEB_BUILD_VERSION__: string | undefined;
declare const __OMP_WEB_BUILD_GIT_HASH__: string | undefined;
declare const __OMP_WEB_BUILD_OMP_VERSION__: string | undefined;

export interface BuildInfo {
	/** omp-web package version. */
	version: string;
	/** Short git commit hash the bundle was built from. */
	gitHash: string;
	/** Upstream omp (`@oh-my-pi/pi-coding-agent`) version. */
	ompVersion: string;
}

export const buildInfo: BuildInfo = {
	version: typeof __OMP_WEB_BUILD_VERSION__ === "string" ? __OMP_WEB_BUILD_VERSION__ : "",
	gitHash: typeof __OMP_WEB_BUILD_GIT_HASH__ === "string" ? __OMP_WEB_BUILD_GIT_HASH__ : "",
	ompVersion:
		typeof __OMP_WEB_BUILD_OMP_VERSION__ === "string" ? __OMP_WEB_BUILD_OMP_VERSION__ : "",
};
