/**
 * Worktree name normalization shared by the fleet (which creates the branch
 * and directory) and the browser (which previews the result before submit),
 * so the preview can never drift from what the server does.
 */

/** Folder name for a worktree: lowercase; runs of non-alphanumerics become `-`, edges trimmed. */
export function slugifyWorktreeName(name: string): string {
	const slug = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug === "" ? "worktree" : slug;
}

/**
 * Branch name for a typed worktree name: the folder slug's rules, except `/`
 * is kept (so `feat/Login fix` becomes `feat/login-fix`); runs of characters
 * outside `[a-z0-9._-]` become `-`; each `/` component drops leading `.`/`-`
 * and trailing `.`, `-`, or `.lock`; `..` and empty components are collapsed.
 * Falls back to the folder slug when nothing usable remains. The fleet still
 * verifies the result with `git check-ref-format --branch`.
 */
export function worktreeBranchName(name: string): string {
	const branch = name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._/-]+/g, "-")
		.replace(/\.{2,}/g, ".")
		.split("/")
		.map((part) => part.replace(/^[.-]+/, "").replace(/(?:\.lock|[.-])+$/, ""))
		.filter((part) => part !== "")
		.join("/");
	return branch === "" ? slugifyWorktreeName(name) : branch;
}
