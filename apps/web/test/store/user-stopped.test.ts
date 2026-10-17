/**
 * The user-stopped marker survives a page reload (U12): it is persisted to
 * localStorage, read back on load, and confirmed against the first roster
 * frame. A mark only survives when its daemon is still asleep then.
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
		clearUserStopped("daemon-a");
		clearUserStopped("daemon-b");
	});
	afterEach(() => {
		restoreBrowserGlobals();
	});

	test("a user stop is written to storage and survives reload once the daemon is confirmed asleep", () => {
		markUserStopped("daemon-a");
		expect(JSON.parse(localStorage.getItem(USER_STOPPED_KEY) ?? "null")).toEqual(["daemon-a"]);

		reload();
		expect(isUserStopped("daemon-a")).toBe(true);

		reconcileUserStopped([{ daemonId: "daemon-a", status: "asleep" }]);
		expect(isUserStopped("daemon-a")).toBe(true);
		expect(localStorage.getItem(USER_STOPPED_KEY)).toBe(JSON.stringify(["daemon-a"]));
	});

	test("a reloaded mark is dropped when its daemon is no longer asleep (woken elsewhere)", () => {
		markUserStopped("daemon-a");
		reload();

		reconcileUserStopped([{ daemonId: "daemon-a", status: "ready" }]);

		expect(isUserStopped("daemon-a")).toBe(false);
		expect(localStorage.getItem(USER_STOPPED_KEY)).toBeNull();
	});

	test("a mark whose daemon left the roster is dropped", () => {
		markUserStopped("daemon-a");
		markUserStopped("daemon-b");
		reload();

		reconcileUserStopped([{ daemonId: "daemon-b", status: "asleep" }]);

		expect(isUserStopped("daemon-a")).toBe(false);
		expect(isUserStopped("daemon-b")).toBe(true);
		expect(JSON.parse(localStorage.getItem(USER_STOPPED_KEY) ?? "null")).toEqual(["daemon-b"]);
	});

	test("clearing the mark (restart) removes it from storage across reload", () => {
		markUserStopped("daemon-a");
		clearUserStopped("daemon-a");

		expect(localStorage.getItem(USER_STOPPED_KEY)).toBeNull();
		reload();
		expect(isUserStopped("daemon-a")).toBe(false);
	});

	test("malformed storage reads as no marks", () => {
		localStorage.setItem(USER_STOPPED_KEY, "{not json");
		reload();
		expect(isUserStopped("daemon-a")).toBe(false);
	});

	test("a mark made in this page load is not re-checked by the first roster frame", () => {
		reconcileUserStopped([{ daemonId: "daemon-a", status: "asleep" }]);
		markUserStopped("daemon-a");

		reconcileUserStopped([{ daemonId: "daemon-a", status: "ready" }]);

		expect(isUserStopped("daemon-a")).toBe(true);
	});
});
