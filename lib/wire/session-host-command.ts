/**
 * The shell command an operator runs on a remote session host after enrolling
 * it (`POST /ctl/enroll`). One formatter shared by the `omp-web enroll` CLI and
 * the browser's Add remote session dialog, so both print the same command.
 * The session dials OUT to `callbackUrl` with the one-time token; the control
 * plane never connects to it.
 */

/** The `enrollment` object of a `POST /ctl/enroll` 201 answer. */
export interface SessionEnrollment {
	workspaceId: string;
	generation: number;
	/** One-time callback credential; shown once, never stored by the fleet. */
	token: string;
	callbackUrl: string;
}

/** `OMP_SESSION_CALLBACK_TOKEN=… omp-web session …` for the session host. `cwd` is the project directory on that host (default: the shell's cwd). */
export function formatSessionHostCommand(enrollment: SessionEnrollment, cwd?: string): string {
	const allowHttp = enrollment.callbackUrl.startsWith("http:") ? " --callback-allow-http" : "";
	return (
		`OMP_SESSION_CALLBACK_TOKEN=${enrollment.token} omp-web session --cwd ${cwd ?? "."} --port 0` +
		` --callback-url ${enrollment.callbackUrl} --callback-workspace ${enrollment.workspaceId}` +
		` --callback-generation ${enrollment.generation}${allowHttp}`
	);
}

/** Narrow an untyped `POST /ctl/enroll` body to its enrollment, or undefined when malformed. */
export function readSessionEnrollment(body: unknown): SessionEnrollment | undefined {
	const e = (body as { enrollment?: Record<string, unknown> } | null)?.enrollment;
	if (
		e === undefined ||
		e === null ||
		typeof e.workspaceId !== "string" ||
		typeof e.generation !== "number" ||
		typeof e.token !== "string" ||
		typeof e.callbackUrl !== "string"
	) {
		return undefined;
	}
	return {
		workspaceId: e.workspaceId,
		generation: e.generation,
		token: e.token,
		callbackUrl: e.callbackUrl,
	};
}
