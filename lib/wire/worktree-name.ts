/**
 * Worktree name normalization shared by the fleet (which creates the branch
 * and directory) and the browser (which previews the result before submit),
 * so the preview can never drift from what the server does.
 */

/** Lowercase a worktree name; runs of non-alphanumerics become `-`, edges trimmed. */
export function slugifyWorktreeName(name: string): string {
	const slug = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug === "" ? "worktree" : slug;
}
