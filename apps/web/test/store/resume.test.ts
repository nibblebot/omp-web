/**
 * Store tests for the resume picker slice (store/resume.ts): the behavior the
 * picker components consume. The browser socket transport is the shared fake; every
 * session answer is dispatched by hand, so nothing touches the network.
 *
 * - "All projects" is sent with every list request and persists in localStorage
 * - pins are server-owned: they survive a store reload because the next list
 *   answer carries them
 * - rename normalizes the title client-side and applies the session's saved one
 * - delete refuses locally before any call, routes attached vs other sessions
 *   to different methods, and keeps the row when the session refuses
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ClientCommand, RosterEntry, RegisteredProject } from "#lib/wire/protocol";
import { connect, setState, state } from "../../state";
import {
	cancelTypedResumeSearch,
	chooseResumeTarget,
	type ResumeCandidate,
	createResumeState,
	deleteResumeSession,
	renameResumeSession,
	resumeAllProjects,
	resumeCandidates,
	resumeError,
	resumePinnedIds,
	resumeQuery,
	resumeTotal,
	searchResume,
	sessionRowsFromResume,
	setResumeAllProjects,
	typeResumeQuery,
} from "../../store/resume";
import { openAddProject } from "../../store/projects";
import {
	FakeWebSocket,
	callResult,
	dispatch,
	flushMicrotasks,
	installLocalStorageShim,
	installTransportStubs,
	posted,
	restoreBrowserGlobals,
} from "../web.testkit";

type CallCommand = Extract<ClientCommand, { type: "call" }>;

function calls(method: string): CallCommand[] {
	return posted.filter((c): c is CallCommand => c.type === "call" && c.method === method);
}

/** Answer the most recent posted call for `method` and let the store settle. */
async function answer(method: string, data: unknown, ok = true, error?: string): Promise<void> {
	const cmd = calls(method).at(-1);
	if (!cmd) throw new Error(`no ${method} call was posted`);
	dispatch(callResult(cmd.id, data, ok, error));
	await flushMicrotasks();
	await flushMicrotasks();
}

function candidate(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id,
		sessionFile: `/sessions/app/${id}.jsonl`,
		cwd: "/work/app",
		modifiedMs: 1_000,
		messageCount: 2,
		scope: "local",
		...overrides,
	};
}

function reset(): void {
	setState("resume", createResumeState());
	setState("sessionFile", undefined);
	setState("currentWorkspaceId", "");
}

beforeEach(() => {
	installTransportStubs();
	installLocalStorageShim();
	connect();
	FakeWebSocket.instances.at(-1)?.onopen?.();
	setState({ modal: null, sessionRoster: [] });
	reset();
});

afterEach(() => {
	reset();
	restoreBrowserGlobals();
});

describe("All projects toggle", () => {
	test("defaults to this project, sends the flag, and re-runs the current query", async () => {
		expect(resumeAllProjects()).toBe(false);

		const first = searchResume("auth");
		expect(calls("resumeList").at(-1)?.args).toEqual([
			{ query: "auth", limit: 200, allProjects: false },
		]);
		await answer("resumeList", { candidates: [candidate("a")], total: 1 });
		await first;

		const toggled = setResumeAllProjects(true);
		expect(resumeAllProjects()).toBe(true);
		expect(calls("resumeList").at(-1)?.args).toEqual([
			{ query: "auth", limit: 200, allProjects: true },
		]);
		await answer("resumeList", {
			candidates: [
				candidate("a"),
				candidate("b", {
					cwd: "/work/other",
					scope: "global",
					sessionFile: "/sessions/other/b.jsonl",
				}),
			],
			total: 2,
		});
		await toggled;
		expect(resumeCandidates().map((c) => c.id)).toEqual(["a", "b"]);
		expect(resumeTotal()).toBe(2);

		const rows = sessionRowsFromResume(resumeCandidates(), undefined);
		expect(rows.map((r) => [r.id, r.projectLabel, r.scope])).toEqual([
			["a", "app", "local"],
			["b", "other", "global"],
		]);
	});

	test("turning it off narrows the list again and the choice survives a reload", async () => {
		const on = setResumeAllProjects(true);
		await answer("resumeList", {
			candidates: [candidate("a"), candidate("b", { cwd: "/work/other", scope: "global" })],
			total: 2,
		});
		await on;
		expect(localStorage.getItem("omp.resumeAllProjects")).toBe("true");

		// "Reload": a fresh store state reads the persisted scope.
		expect(createResumeState().allProjects).toBe(true);

		const off = setResumeAllProjects(false);
		expect(calls("resumeList").at(-1)?.args).toEqual([
			{ query: "", limit: 200, allProjects: false },
		]);
		await answer("resumeList", { candidates: [candidate("a")], total: 1 });
		await off;
		expect(localStorage.getItem("omp.resumeAllProjects")).toBe("false");
		expect(createResumeState().allProjects).toBe(false);
		expect(resumeCandidates().map((c) => c.id)).toEqual(["a"]);
		expect(resumeTotal()).toBe(1);
	});

	test("a stale list answer never overwrites the newer scope's result", async () => {
		const stale = searchResume("");
		const stalePost = calls("resumeList").at(-1);
		const fresh = setResumeAllProjects(true);
		await answer("resumeList", { candidates: [candidate("wide")], total: 1 });
		await fresh;

		if (!stalePost) throw new Error("missing first call");
		dispatch(callResult(stalePost.id, { candidates: [candidate("narrow")], total: 1 }));
		await stale;
		expect(resumeCandidates().map((c) => c.id)).toEqual(["wide"]);
	});
});

describe("pins", () => {
	test("the list answer's pinned ids mark candidates, including after a store reload", async () => {
		const loaded = searchResume("");
		await answer("resumeList", {
			candidates: [candidate("a"), candidate("b")],
			pinnedIds: ["b"],
			total: 2,
		});
		await loaded;
		expect(resumePinnedIds()).toEqual(["b"]);
		expect(resumeCandidates().map((c) => [c.id, c.pinned])).toEqual([
			["a", false],
			["b", true],
		]);

		// "Reload": the mirror is empty until the session answers again. Pins live in
		// the session's pins file, so the same answer restores them.
		reset();
		expect(resumeCandidates()).toEqual([]);
		expect(resumePinnedIds()).toEqual([]);
		const reloaded = searchResume("");
		await answer("resumeList", {
			candidates: [candidate("a"), candidate("b")],
			pinnedIds: ["b"],
			total: 2,
		});
		await reloaded;
		expect(
			sessionRowsFromResume(resumeCandidates(), undefined).map((r) => [r.id, r.pinned]),
		).toEqual([
			["a", false],
			["b", true],
		]);
	});
});

describe("rename", () => {
	async function load(): Promise<void> {
		const loaded = searchResume("");
		await answer("resumeList", { candidates: [candidate("a"), candidate("b")], total: 2 });
		await loaded;
	}

	test("sends the trimmed title for the file and applies the session's saved title", async () => {
		await load();
		const done = renameResumeSession({ id: "a", file: "/sessions/app/a.jsonl" }, "  Auth rework  ");
		expect(calls("resumeRename").at(-1)?.args).toEqual([
			{ sessionFile: "/sessions/app/a.jsonl", title: "Auth rework" },
		]);
		await answer("resumeRename", { renamed: true, sessionId: "a", title: "Auth rework" });
		expect(await done).toBe(true);
		expect(resumeCandidates().find((c) => c.id === "a")?.title).toBe("Auth rework");
		expect(resumeCandidates().find((c) => c.id === "b")?.title).toBeUndefined();
	});

	test("an empty or over-long title never reaches the session", async () => {
		await load();
		expect(await renameResumeSession({ id: "a", file: "/sessions/app/a.jsonl" }, "   ")).toBe(
			false,
		);
		expect(
			await renameResumeSession({ id: "a", file: "/sessions/app/a.jsonl" }, "x".repeat(201)),
		).toBe(false);
		expect(calls("resumeRename")).toEqual([]);
		expect(resumeError()).toBe("Session names must be 1 to 200 characters on one line.");
	});

	test("a multi-line title is collapsed to one line before it is sent", async () => {
		await load();
		const done = renameResumeSession({ id: "a", file: "/sessions/app/a.jsonl" }, "a\n  b");
		expect(calls("resumeRename").at(-1)?.args).toEqual([
			{ sessionFile: "/sessions/app/a.jsonl", title: "a b" },
		]);
		await answer("resumeRename", { renamed: true, sessionId: "a", title: "a b" });
		expect(await done).toBe(true);
	});

	test("a session refusal surfaces as the picker error and keeps the old title", async () => {
		await load();
		const done = renameResumeSession({ id: "a", file: "/sessions/app/a.jsonl" }, "New name");
		await answer("resumeRename", undefined, false, "Session is owned by another writer");
		expect(await done).toBe(false);
		expect(resumeError()).toContain("owned by another writer");
		expect(resumeCandidates().find((c) => c.id === "a")?.title).toBeUndefined();
	});
});

describe("delete", () => {
	async function load(): Promise<void> {
		setState("resume", "capabilities", { manage: true });
		const loaded = searchResume("");
		await answer("resumeList", {
			candidates: [candidate("a"), candidate("b"), candidate("c")],
			pinnedIds: ["b"],
			total: 3,
		});
		await loaded;
	}

	test("refuses a non-.jsonl file or a missing id before any call", async () => {
		await load();
		expect(await deleteResumeSession({ id: "a", file: "/sessions/app/a.txt" })).toBe(false);
		expect(resumeError()).toBe("Only .jsonl session logs can be deleted.");
		expect(await deleteResumeSession({ id: "", file: "/sessions/app/a.jsonl" })).toBe(false);
		expect(calls("resumeDelete")).toEqual([]);
		expect(calls("deleteSession")).toEqual([]);
		expect(resumeCandidates()).toHaveLength(3);
	});

	test("refuses an unattached session when the server cannot manage sessions", async () => {
		await load();
		setState("resume", "capabilities", { manage: false });
		expect(await deleteResumeSession({ id: "a", file: "/sessions/app/a.jsonl" })).toBe(false);
		expect(resumeError()).toBe("This server cannot delete sessions that are not attached.");
		expect(calls("resumeDelete")).toEqual([]);
	});

	test("deleting another session sends its file and id, then drops the row, pin, and count", async () => {
		await load();
		const done = deleteResumeSession({ id: "b", file: "/sessions/app/b.jsonl" });
		expect(calls("resumeDelete").at(-1)?.args).toEqual([
			{ sessionFile: "/sessions/app/b.jsonl", sessionId: "b" },
		]);
		expect(calls("deleteSession")).toEqual([]);
		await answer("resumeDelete", { deleted: true, sessionId: "b" });
		expect(await done).toBe(true);
		expect(resumeCandidates().map((c) => c.id)).toEqual(["a", "c"]);
		expect(resumePinnedIds()).toEqual([]);
		expect(resumeTotal()).toBe(2);
		expect(state.resume.notice).toBe("Session deleted.");
	});

	test("the attached session goes through deleteSession and the list reloads", async () => {
		await load();
		setState("sessionFile", "/sessions/app/a.jsonl");
		const done = deleteResumeSession({ id: "a", file: "/sessions/app/a.jsonl" });
		expect(calls("deleteSession")).toHaveLength(1);
		expect(calls("resumeDelete")).toEqual([]);
		await answer("deleteSession", { deleted: true });
		expect(await done).toBe(true);
		// The session replaced the session, so the list is re-fetched, not trusted locally.
		expect(calls("resumeList")).toHaveLength(2);
	});

	test("a session refusal (not in the owning listing) keeps the row and shows the reason", async () => {
		await load();
		const done = deleteResumeSession({ id: "c", file: "/sessions/app/c.jsonl" });
		await answer("resumeDelete", undefined, false, "Session file is not in the session listing");
		expect(await done).toBe(false);
		expect(resumeError()).toBe("Session file is not in the session listing");
		expect(resumeCandidates().map((c) => c.id)).toEqual(["a", "b", "c"]);
		expect(resumeTotal()).toBe(3);
	});
});

describe("owner resolution when resuming", () => {
	const sessionFile = "/sessions/other/s1.jsonl";

	beforeEach(() => {
		setState("currentWorkspaceId", "d-app");
	});

	function entry(workspaceId: string, cwd: string, extra: Partial<RosterEntry> = {}): RosterEntry {
		return {
			workspaceId,
			name: workspaceId,
			cwd,
			project: workspaceId,
			status: "asleep",
			...extra,
		};
	}

	function project(projectId: string, path: string): RegisteredProject {
		return { projectId, path, name: projectId, addedAt: 1 };
	}

	function resumeRow(id: string, cwd: string): ResumeCandidate {
		return {
			id,
			sessionFile: `/sessions/${id}.jsonl`,
			cwd,
			modifiedMs: 1,
			messageCount: 1,
			pinned: false,
			scope: "global",
		};
	}

	/** Start a by-id resume; the session's resolve answers with one unique session in `cwd`. */
	function resolveUnique(cwd: string): Promise<unknown> {
		const pending = chooseResumeTarget("s1");
		void answer("resumeResolve", {
			kind: "unique",
			session: candidate("s1", { cwd, sessionFile, scope: "global" }),
		});
		return pending;
	}

	test("an asleep session on the folder wakes with the chosen file and nothing is refused", async () => {
		setState({
			sessionRoster: [
				entry("d-app", "/work/app", { status: "ready" }),
				entry("d-other", "/work/other"),
			],
			registeredProjects: [project("p1", "/work/other")],
		});
		void resolveUnique("/work/other");
		await flushMicrotasks();
		expect(posted.filter((c) => c.type === "spawn_resume")).toEqual([
			expect.objectContaining({ workspaceId: "d-other", sessionFile }),
		]);
		expect(resumeError()).toBeNull();
	});

	test("two sessions on one folder keep the explicit choice and wake nothing", async () => {
		setState({ sessionRoster: [entry("d-1", "/work/other"), entry("d-2", "/work/other")] });
		await resolveUnique("/work/other");
		expect(resumeError()).toBe(
			"Select the owning profile/workspace/directory in the roster before resuming this session.",
		);
		expect(posted.filter((c) => c.type === "spawn_resume")).toEqual([]);
	});

	test("a registered project with no session is started, then resumes once its session is ready", async () => {
		setState({
			sessionRoster: [entry("d-app", "/work/app", { status: "ready" })],
			registeredProjects: [project("p1", "/work/other")],
		});
		void resolveUnique("/work/other");
		await flushMicrotasks();
		expect(resumeError()).toBeNull();
		expect(posted.filter((c) => c.type === "spawn")).toEqual([
			expect.objectContaining({ cwd: "/work/other" }),
		]);
		expect(posted.filter((c) => c.type === "attach")).toEqual([]);

		dispatch({
			type: "roster",
			entries: [
				entry("d-app", "/work/app", { status: "ready" }),
				entry("d-new", "/work/other", { status: "spawning" }),
			],
		});
		await flushMicrotasks();
		expect(posted.filter((c) => c.type === "attach")).toEqual([]);

		dispatch({
			type: "roster",
			entries: [
				entry("d-app", "/work/app", { status: "ready" }),
				entry("d-new", "/work/other", { status: "ready" }),
			],
		});
		await flushMicrotasks();
		const attach = posted.filter((c) => c.type === "attach").at(-1);
		expect(attach).toEqual(expect.objectContaining({ workspaceId: "d-new" }));
		if (attach?.type !== "attach") throw new Error("expected an attach command");
		dispatch({ type: "attach_result", id: attach.id, ok: true, workspaceId: "d-new" });
		await flushMicrotasks();
		expect(calls("switchSession").at(-1)?.args).toEqual([sessionFile]);
	});

	test("with no session attached it refuses at once instead of parking the call until it times out (Open in Chat)", async () => {
		setState("currentWorkspaceId", "");
		const outcome = await chooseResumeTarget("s1");
		expect(outcome.kind).toBe("refused");
		expect(resumeError()).toContain("Open a workspace in Chat first");
		expect(calls("resumeResolve")).toEqual([]);
	});

	test("a folder no registered project owns is refused with the path, and nothing starts", async () => {
		setState({
			sessionRoster: [entry("d-app", "/work/app", { status: "ready" })],
			registeredProjects: [project("p1", "/work/app")],
		});
		const outcome = chooseResumeTarget("s1");
		await answer("resumeResolve", {
			kind: "unique",
			session: candidate("s1", { cwd: "/work/gone", sessionFile, scope: "global" }),
		});
		expect((await outcome).kind).toBe("refused");
		expect(resumeError()).toBe(
			"No registered project owns /work/gone. Use Add project to register it before resuming this session.",
		);
		const started = posted.filter((c) => ["spawn", "spawn_resume", "attach"].includes(c.type));
		expect(started).toEqual([]);
		expect(calls("switchSession")).toEqual([]);
	});

	test("rows in a folder no registered project owns are blocked with the reason and the path to add", () => {
		setState({
			sessionRoster: [entry("d-app", "/work/app", { status: "ready" })],
			registeredProjects: [project("p1", "/work/app"), project("p2", "/work/asleep")],
		});
		const rows = sessionRowsFromResume(
			[
				resumeRow("own", "/work/app"),
				resumeRow("reg", "/work/asleep"),
				resumeRow("gone", "/work/gone/"),
				resumeRow("nocwd", ""),
			],
			undefined,
		);
		expect(rows.map((r) => [r.id, r.blocked?.addProjectPath ?? null])).toEqual([
			["own", null],
			["reg", null],
			["gone", "/work/gone"],
			["nocwd", null],
		]);
		expect(rows[2]?.blocked?.reason).toBe(
			"No registered project owns this folder. Add it as a project to resume.",
		);
	});

	test("Add project from an unowned session opens the dialog with the folder prefilled", () => {
		openAddProject("/work/gone");
		expect(state.modal).toBe("add-project");
		expect(state.addProjectPath).toBe("/work/gone");
		openAddProject();
		expect(state.addProjectPath).toBeNull();
	});
});

describe("typed query", () => {
	const PAUSE_MS = 260; // past SEARCH_DEBOUNCE_MS

	test("a query typed at speed sends one list request after the pause, with every keystroke shown at once", async () => {
		for (const typed of ["r", "re", "ref", "refa", "refac", "refact", "refacto", "refactor"]) {
			typeResumeQuery(typed);
			expect(resumeQuery()).toBe(typed);
		}
		expect(calls("resumeList")).toHaveLength(0);

		await Bun.sleep(PAUSE_MS);
		expect(calls("resumeList")).toHaveLength(1);
		expect(calls("resumeList")[0]?.args).toEqual([
			{ query: "refactor", limit: 200, allProjects: false },
		]);
		await answer("resumeList", { candidates: [candidate("a")], total: 1 });
		expect(resumeCandidates().map((c) => c.id)).toEqual(["a"]);
	});

	test("a search issued meanwhile (scope toggle) supersedes the pending typed search", async () => {
		typeResumeQuery("auth");
		const toggled = setResumeAllProjects(true);
		expect(calls("resumeList")).toHaveLength(1);
		await Bun.sleep(PAUSE_MS);
		expect(calls("resumeList")).toHaveLength(1);
		await answer("resumeList", { candidates: [], total: 0 });
		await toggled;
	});

	test("closing the picker drops the pending typed search", async () => {
		typeResumeQuery("auth");
		cancelTypedResumeSearch();
		await Bun.sleep(PAUSE_MS);
		expect(calls("resumeList")).toHaveLength(0);
	});
});
