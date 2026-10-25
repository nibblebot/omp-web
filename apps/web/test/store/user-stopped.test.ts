/**
 * The user-stopped marker survives a page reload (U12): it is persisted to
 * localStorage, read back on load, and confirmed against the first roster
 * frame. A mark only survives when its session is still asleep then.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { installLocalStorageShim, restoreBrowserGlobals } from "../web.testkit";
import {
	USER_STOPPED_KEY,
	clearUserStopped,
	isUserStopped,
	loadUserStopped,
	markUserStopped,
	reconcileUserStopped,
} from "../../store/user-stopped";

/** Models a reload: the in-memory set is rebuilt from storage. */
function reload(): void {
	loadUserStopped();
}

describe("user-stopped marker persistence", () => {
	beforeEach(() => {
		installLocalStorageShim();
		localStorage.clear();
		clearUserStopped("workspace-a");
		clearUserStopped("workspace-b");
	});
	afterEach(() => {
		restoreBrowserGlobals();
	});

	test("a user stop is written to storage and survives reload once the session is confirmed asleep", () => {
		markUserStopped("workspace-a");
		expect(JSON.parse(localStorage.getItem(USER_STOPPED_KEY) ?? "null")).toEqual(["workspace-a"]);

		reload();
		expect(isUserStopped("workspace-a")).toBe(true);

		reconcileUserStopped([{ workspaceId: "workspace-a", status: "asleep" }]);
		expect(isUserStopped("workspace-a")).toBe(true);
		expect(localStorage.getItem(USER_STOPPED_KEY)).toBe(JSON.stringify(["workspace-a"]));
	});

	test("a reloaded mark is dropped when its session is no longer asleep (woken elsewhere)", () => {
		markUserStopped("workspace-a");
		reload();

		reconcileUserStopped([{ workspaceId: "workspace-a", status: "ready" }]);

		expect(isUserStopped("workspace-a")).toBe(false);
		expect(localStorage.getItem(USER_STOPPED_KEY)).toBeNull();
	});

	test("a mark whose session left the roster is dropped", () => {
		markUserStopped("workspace-a");
		markUserStopped("workspace-b");
		reload();

		reconcileUserStopped([{ workspaceId: "workspace-b", status: "asleep" }]);

		expect(isUserStopped("workspace-a")).toBe(false);
		expect(isUserStopped("workspace-b")).toBe(true);
		expect(JSON.parse(localStorage.getItem(USER_STOPPED_KEY) ?? "null")).toEqual(["workspace-b"]);
	});

	test("clearing the mark (restart) removes it from storage across reload", () => {
		markUserStopped("workspace-a");
		clearUserStopped("workspace-a");

		expect(localStorage.getItem(USER_STOPPED_KEY)).toBeNull();
		reload();
		expect(isUserStopped("workspace-a")).toBe(false);
	});

	test("malformed storage reads as no marks", () => {
		localStorage.setItem(USER_STOPPED_KEY, "{not json");
		reload();
		expect(isUserStopped("workspace-a")).toBe(false);
	});

	test("a mark made in this page load is not re-checked by the first roster frame", () => {
		reconcileUserStopped([{ workspaceId: "workspace-a", status: "asleep" }]);
		markUserStopped("workspace-a");

		reconcileUserStopped([{ workspaceId: "workspace-a", status: "ready" }]);

		expect(isUserStopped("workspace-a")).toBe(true);
	});
});
