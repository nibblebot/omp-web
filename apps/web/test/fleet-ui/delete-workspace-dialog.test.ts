/**
 * DeleteWorkspaceDialog guard-evidence branches: clean linked evidence offers
 * the Delete control; evidence whose git probe failed (probeFailed) refuses
 * outright, showing the reason and offering only Cancel.
 *
 * The dialog renders through solid's SSR runtime, so no DOM is needed. The
 * shared JSX shim maps Bun's React-style transform onto SSR primitives and
 * intercepts the generic Modal shell: its DOM focus/keyboard lifecycle is not
 * part of these guard-evidence assertions, but its dialog children are.
 * Assertions are branch-level (which bodies and controls exist), not markup
 * parity with the browser build.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import * as solidWeb from "solid-js/web";
import { DeleteWorkspaceDialog } from "../../components/fleet/workspaces/DeleteWorkspaceDialog";
import { Modal } from "../../components/ui/Modal";
import { setState, type WorktreeDeleteInfo } from "../../state";
import { installJsxShim, restoreJsxShim } from "../web.testkit";

beforeEach(() => {
	installJsxShim({
		onElement(type, props) {
			return type === Modal ? { value: props.children } : undefined;
		},
	});
});

afterAll(() => {
	restoreJsxShim();
});

const TARGET = "dmn_probe";

const CLEAN: WorktreeDeleteInfo = {
	type: "worktree_delete_info",
	daemonId: TARGET,
	linked: true,
	dirty: false,
	branch: "feat/clean",
	merged: true,
	unpushed: false,
};

const UNPROVEN: WorktreeDeleteInfo = {
	type: "worktree_delete_info",
	daemonId: TARGET,
	linked: true,
	dirty: false,
	probeFailed: true,
	reason: "worktree git state could not be read; deleting is refused",
};

const DIRTY: WorktreeDeleteInfo = {
	type: "worktree_delete_info",
	daemonId: TARGET,
	linked: true,
	dirty: true,
	branch: "feat/dirty",
	merged: false,
	unpushed: false,
	git: { added: 0, modified: 2, deleted: 0, untracked: 3, linesAdded: 1, linesDeleted: 0 },
	reason: "commit or stash the changes first",
};

/** Render the dialog with `evidence` as the target's guard evidence. */
function renderDialog(evidence: WorktreeDeleteInfo): string {
	setState({ deleteWorkspaceTarget: TARGET, worktreeDeleteInfo: { [TARGET]: evidence } });
	return solidWeb.renderToString(() => createComponent(DeleteWorkspaceDialog, {}));
}

describe("DeleteWorkspaceDialog guard evidence", () => {
	test("clean linked evidence offers the Delete control", () => {
		const html = renderDialog(CLEAN);
		expect(html).toContain("danger-confirm-btn");
		expect(html).toContain("Delete worktree</button>");
		expect(html).not.toContain("cannot be verified");
	});

	test("unproven evidence refuses: the reason shows, no Delete control renders", () => {
		const html = renderDialog(UNPROVEN);
		expect(html).toContain("This worktree cannot be verified as safe to delete");
		expect(html).toContain(UNPROVEN.reason!);
		expect(html).not.toContain("danger-confirm-btn");
		expect(html).toContain("Cancel</button>");
	});

	test("dirty evidence lists the changed files, offers Open review, and keeps Delete disabled", () => {
		const html = renderDialog({
			...DIRTY,
			files: ["src/a.ts", "src/b.ts"],
			git: { added: 0, modified: 2, deleted: 0, untracked: 3, linesAdded: 1, linesDeleted: 0 },
		});
		expect(html).toContain("worktree-dirty-files");
		expect(html).toContain("src/a.ts");
		expect(html).toContain("src/b.ts");
		expect(html).toContain("3 more not listed");
		expect(html).toContain("Open review</button>");
		expect(html).toMatch(/<button[^>]*disabled[^>]*>Delete worktree/);
	});

	test("branch hint states only what is known about the branch", () => {
		const noUpstream = renderDialog({ ...CLEAN, hasUpstream: false });
		expect(noUpstream).toContain("merged, no upstream");
		expect(noUpstream).not.toContain("merged and pushed");
		const pushed = renderDialog({ ...CLEAN, hasUpstream: true });
		expect(pushed).toContain("merged and pushed");
		const unpushed = renderDialog({ ...CLEAN, hasUpstream: true, unpushed: true });
		expect(unpushed).toContain("merged but unpushed");
	});

	test("branch deletion is pre-checked only when merged with nothing unpushed", () => {
		const merged = renderDialog(CLEAN);
		expect(merged).toMatch(/type="checkbox"[^>]*checked/);
		const unmerged = renderDialog({ ...CLEAN, merged: false });
		expect(unmerged).not.toMatch(/type="checkbox"[^>]*checked/);
		const unpushed = renderDialog({ ...CLEAN, unpushed: true });
		expect(unpushed).not.toMatch(/type="checkbox"[^>]*checked/);
	});

	test("a refused branch hides the checkbox and shows the reason", () => {
		const html = renderDialog({ ...CLEAN, branchDeleteRefused: "protected branch" });
		expect(html).not.toContain('type="checkbox"');
		expect(html).toContain("is kept:");
		expect(html).toContain("protected branch");
	});
});
