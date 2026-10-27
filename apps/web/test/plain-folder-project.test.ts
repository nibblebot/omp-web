/**
 * A plain-folder project (RegisteredProject.git === false) has no worktrees,
 * branches or diffstats: its rows lead with the session title and offer no
 * worktree actions, and its header has no "+" to create a workspace. A clone
 * in the same project, and every row of a git project, are unaffected.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import * as solidWeb from "solid-js/web";
import type { RegisteredProject, RosterEntry } from "#lib/wire/protocol";
import { ProjectGroups } from "../components/fleet/sidebar/ProjectGroups";
import { WorkspaceRow, setMenuOpenId } from "../components/fleet/sidebar/WorkspaceRow";
import { setState, state } from "../state";
import {
	installJsxShim,
	installLocalStorageShim,
	restoreBrowserGlobals,
	restoreJsxShim,
} from "./web.testkit";

const TITLE = "Refactor the parser";
const BRANCH = "feature/parser";

function project(extra: Partial<RegisteredProject> = {}): RegisteredProject {
	return {
		projectId: "proj_notes",
		path: "/notes",
		name: "notes",
		addedAt: 1,
		...extra,
	};
}

/** A worktree-shaped row with a branch, a diffstat and a session title. */
function worktreeRow(extra: Partial<RosterEntry> = {}): RosterEntry {
	return {
		workspaceId: "ws-folder",
		name: "notes",
		cwd: "/notes",
		project: "notes",
		status: "ready",
		worktreeOf: "/notes",
		branch: BRANCH,
		sessionTitle: TITLE,
		git: { added: 0, modified: 3, deleted: 0, untracked: 0, linesAdded: 12, linesDeleted: 4 },
		...extra,
	} as RosterEntry;
}

function cloneRow(): RosterEntry {
	return worktreeRow({
		workspaceId: "ws-clone",
		name: "notes-clone",
		cwd: "/clones/notes-clone",
		worktreeOf: undefined,
		workspaceKind: "clone",
		branch: undefined,
	});
}

function renderRow(entry: RosterEntry, projectGit: boolean | undefined, menuOpen = false): string {
	if (menuOpen) setMenuOpenId(entry.workspaceId);
	try {
		return solidWeb.renderToString(() =>
			createComponent(WorkspaceRow, { session: entry, inProjectGroup: true, projectGit }),
		);
	} finally {
		setMenuOpenId(null);
	}
}

/** The row's top line: everything before the corner slot. */
function topLine(html: string): string {
	const start = html.indexOf("sidebar-row-top");
	const end = html.indexOf("roster-row-corner");
	expect(start).toBeGreaterThan(-1);
	expect(end).toBeGreaterThan(start);
	return html.slice(start, end);
}

function renderHeader(p: RegisteredProject): string {
	return solidWeb.renderToString(() =>
		createComponent(ProjectGroups, { groups: [{ project: p, sessions: [worktreeRow()] }] }),
	);
}

const savedTitleFirst = state.sidebarTitleFirst;

beforeEach(() => {
	installLocalStorageShim();
	installJsxShim();
	setState("sidebarTitleFirst", false);
});

afterEach(() => {
	setState("sidebarTitleFirst", savedTitleFirst);
	setMenuOpenId(null);
});

afterAll(() => {
	restoreJsxShim();
	restoreBrowserGlobals();
});

describe("plain-folder rows", () => {
	test("show no branch, worktree icon or diffstat, and lead with the session title", () => {
		const html = renderRow(worktreeRow(), false);
		expect(html).not.toContain(BRANCH);
		// The kind icon is the only role=img on the row's top line.
		expect(topLine(html)).not.toContain('role="img"');
		expect(html).not.toContain("changed");
		expect(html).not.toContain("+12");
		expect(topLine(html)).toContain(TITLE);
	});

	test("offer no Delete worktree", () => {
		expect(renderRow(worktreeRow(), false, true)).not.toContain("Delete worktree");
		expect(renderRow(worktreeRow(), true, true)).toContain("Delete worktree");
	});

	test("a clone row in the same project is unaffected", () => {
		const html = renderRow(cloneRow(), false);
		expect(html).toContain("notes-clone");
		expect(topLine(html)).toContain('role="img"');
		expect(html).toContain("3 files changed");
		expect(html).toContain("+12");
		expect(topLine(html)).toContain("notes-clone");
	});

	test("a git project's row keeps its branch on the top line and the title below", () => {
		const html = renderRow(worktreeRow(), true);
		expect(topLine(html)).toContain(BRANCH);
		expect(topLine(html)).not.toContain(TITLE);
		expect(html).toContain(TITLE);
		expect(html).toContain("3 files changed");
	});
});

describe("project header", () => {
	test("hides the New workspace button for a plain folder and shows it otherwise", () => {
		expect(renderHeader(project({ git: false }))).not.toContain("New workspace in notes");
		expect(renderHeader(project())).toContain("New workspace in notes");
	});
});
