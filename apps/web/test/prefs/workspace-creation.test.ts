import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
	currentWorkspaceCreationPrefs,
	rememberWorkspaceCreationPrefs,
	type WorkspaceCreationPrefs,
} from "../../prefs/workspace-creation";

/** Process-global stubs for the browser APIs the prefs module touches; restored in afterAll. */
const installed: Array<{ key: string; original: PropertyDescriptor | undefined }> = [];
function installGlobal(key: string, value: unknown): void {
	installed.push({ key, original: Object.getOwnPropertyDescriptor(globalThis, key) });
	Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}

const storage = new Map<string, string>();

beforeAll(() => {
	installGlobal("localStorage", {
		getItem: (k: string) => storage.get(k) ?? null,
		setItem: (k: string, v: string) => void storage.set(k, v),
		removeItem: (k: string) => void storage.delete(k),
	});
	installGlobal("location", { origin: "http://fleet.test" });
});

beforeEach(() => {
	storage.clear();
});

afterAll(() => {
	for (const { key, original } of installed.reverse()) {
		if (original) Object.defineProperty(globalThis, key, original);
		else delete (globalThis as Record<string, unknown>)[key];
	}
});

describe("workspace creation prefs", () => {
	test("unknown project has no remembered choice", () => {
		expect(currentWorkspaceCreationPrefs("proj_a")).toEqual({});
	});

	test("round-trips a clone choice per project", () => {
		rememberWorkspaceCreationPrefs("proj_a", {
			kind: "clone",
			profileId: "k8s-main",
			source: "remote",
			remote: "origin",
		});
		expect(currentWorkspaceCreationPrefs("proj_a")).toEqual({
			kind: "clone",
			profileId: "k8s-main",
			source: "remote",
			remote: "origin",
		});
		// Another project is not affected.
		expect(currentWorkspaceCreationPrefs("proj_b")).toEqual({});
	});

	test("remember replaces the previous choice wholesale", () => {
		rememberWorkspaceCreationPrefs("proj_a", { kind: "clone", profileId: "p", source: "local" });
		rememberWorkspaceCreationPrefs("proj_a", { kind: "worktree" });
		expect(currentWorkspaceCreationPrefs("proj_a")).toEqual({ kind: "worktree" });
	});

	test("never stores fields outside the allowed shape", () => {
		// Extra fields smuggled past the type must not reach storage.
		rememberWorkspaceCreationPrefs("proj_a", {
			kind: "clone",
			profileId: "p",
			source: "local",
			branch: "feat/x",
			revision: "abc123",
		} as WorkspaceCreationPrefs);
		const raw = storage.get("omp.workspaceCreation.http://fleet.test.proj_a") ?? "";
		expect(raw).not.toContain("feat/x");
		expect(raw).not.toContain("abc123");
	});

	test("malformed stored values read as no preference", () => {
		storage.set("omp.workspaceCreation.http://fleet.test.proj_a", "not json{");
		expect(currentWorkspaceCreationPrefs("proj_a")).toEqual({});
		storage.set("omp.workspaceCreation.http://fleet.test.proj_a", "[1,2]");
		expect(currentWorkspaceCreationPrefs("proj_a")).toEqual({});
	});

	test("invalid field values are dropped, valid ones kept", () => {
		storage.set(
			"omp.workspaceCreation.http://fleet.test.proj_a",
			JSON.stringify({ kind: "bogus", profileId: 7, source: "remote", remote: "" }),
		);
		expect(currentWorkspaceCreationPrefs("proj_a")).toEqual({ source: "remote" });
	});
});
