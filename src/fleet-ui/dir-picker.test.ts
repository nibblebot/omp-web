import { describe, expect, test } from "bun:test";
import type { FsBrowseResult } from "../store/projects";
import { type BrowseFn, createDirPicker } from "./dir-picker";

function listing(partial: Partial<FsBrowseResult> & Pick<FsBrowseResult, "path">): FsBrowseResult {
	return { parent: null, dirs: [], truncated: false, ...partial };
}

/** Browse stub recording its args; `impl` answers per call. */
function stubBrowse(impl: (path?: string) => Promise<FsBrowseResult>) {
	const calls: Array<string | undefined> = [];
	const browse: BrowseFn = (path) => {
		calls.push(path);
		return impl(path);
	};
	return { browse, calls };
}

describe("createDirPicker navigate", () => {
	test("omitted path browses the home dir and populates state", async () => {
		const { browse, calls } = stubBrowse(() =>
			Promise.resolve(
				listing({
					path: "/home/u",
					parent: "/home",
					dirs: [
						{ name: "proj", path: "/home/u/proj", hasGit: true },
						{ name: "tmp", path: "/home/u/tmp", hasGit: false },
					],
					truncated: true,
				}),
			),
		);
		const picker = createDirPicker(browse);
		await picker.navigate();
		expect(calls).toEqual([undefined]);
		const st = picker.state();
		expect(st.currentPath).toBe("/home/u");
		expect(st.parent).toBe("/home");
		expect(st.dirs.map((d) => d.name)).toEqual(["proj", "tmp"]);
		expect(st.truncated).toBe(true);
		expect(st.loading).toBe(false);
		expect(st.error).toBeNull();
		// Not reached via a listing row: the current dir's git bit is unknown.
		expect(st.hasGit).toBeNull();
	});

	test("~ and ~/rel pass through verbatim (expanded edge-side)", async () => {
		const { browse, calls } = stubBrowse((path) =>
			Promise.resolve(listing({ path: path === "~" ? "/home/u" : "/home/u/proj", parent: "/" })),
		);
		const picker = createDirPicker(browse);
		await picker.navigate("~");
		await picker.navigate("~/proj");
		expect(calls).toEqual(["~", "~/proj"]);
		expect(picker.state().currentPath).toBe("/home/u/proj");
	});

	test("row navigation records hasGit; plain navigation resets it to unknown", async () => {
		const { browse } = stubBrowse((path) =>
			Promise.resolve(listing({ path: path ?? "/home/u", parent: "/home" })),
		);
		const picker = createDirPicker(browse);
		await picker.navigate("/home/u/proj", { hasGit: true });
		expect(picker.state().hasGit).toBe(true);
		await picker.navigate("/home/u/other");
		expect(picker.state().hasGit).toBeNull();
	});

	test("error surfaces and keeps the previous listing", async () => {
		let fail = false;
		const { browse } = stubBrowse((path) =>
			fail
				? Promise.reject(new Error("not a directory"))
				: Promise.resolve(
						listing({
							path: path ?? "/home/u",
							parent: "/home",
							dirs: [{ name: "proj", path: "/home/u/proj", hasGit: true }],
						}),
					),
		);
		const picker = createDirPicker(browse);
		await picker.navigate("/home/u");
		fail = true;
		await picker.navigate("/home/u/nope");
		const st = picker.state();
		expect(st.error).toBe("not a directory");
		expect(st.loading).toBe(false);
		// Previous listing stays on screen behind the notice.
		expect(st.currentPath).toBe("/home/u");
		expect(st.dirs).toHaveLength(1);
	});

	test("a slow earlier navigation never clobbers a newer one (latest-wins)", async () => {
		const gates = new Map<string | undefined, (r: FsBrowseResult) => void>();
		const { browse } = stubBrowse(
			(path) =>
				new Promise<FsBrowseResult>((resolve) => {
					gates.set(path, resolve);
				}),
		);
		const picker = createDirPicker(browse);
		const first = picker.navigate("/slow");
		const second = picker.navigate("/fast");
		gates.get("/fast")!(listing({ path: "/fast", parent: "/" }));
		await second;
		expect(picker.state().currentPath).toBe("/fast");
		gates.get("/slow")!(listing({ path: "/slow", parent: "/" }));
		await first;
		expect(picker.state().currentPath).toBe("/fast");
	});
});

describe("createDirPicker up/refresh", () => {
	test("up() browses the parent (hasGit back to unknown)", async () => {
		const { browse, calls } = stubBrowse((path) =>
			Promise.resolve(listing({ path: path ?? "", parent: path === "/home/u" ? "/home" : null })),
		);
		const picker = createDirPicker(browse);
		await picker.navigate("/home/u", { hasGit: true });
		await picker.up();
		expect(calls).toEqual(["/home/u", "/home"]);
		expect(picker.state().currentPath).toBe("/home");
		expect(picker.state().hasGit).toBeNull();
	});

	test("up() at the filesystem root is a no-op", async () => {
		const { browse, calls } = stubBrowse(() =>
			Promise.resolve(listing({ path: "/", parent: null })),
		);
		const picker = createDirPicker(browse);
		await picker.navigate("/");
		await picker.up();
		expect(calls).toEqual(["/"]);
		expect(picker.state().currentPath).toBe("/");
	});

	test("up() before the first load is a no-op", async () => {
		const { browse, calls } = stubBrowse(() => Promise.resolve(listing({ path: "/" })));
		const picker = createDirPicker(browse);
		await picker.up();
		expect(calls).toEqual([]);
	});

	test("refresh() re-lists the current path and preserves a known hasGit", async () => {
		const { browse, calls } = stubBrowse((path) =>
			Promise.resolve(listing({ path: path ?? "", parent: "/" })),
		);
		const picker = createDirPicker(browse);
		await picker.navigate("/home/u/proj", { hasGit: false });
		await picker.refresh();
		expect(calls).toEqual(["/home/u/proj", "/home/u/proj"]);
		expect(picker.state().hasGit).toBe(false);
	});

	test("refresh() before the first load is a no-op", async () => {
		const { browse, calls } = stubBrowse(() => Promise.resolve(listing({ path: "/" })));
		const picker = createDirPicker(browse);
		await picker.refresh();
		expect(calls).toEqual([]);
	});
});

describe("createDirPicker subscribe", () => {
	test("listeners fire on state changes; unsubscribe stops them", async () => {
		const { browse } = stubBrowse((path) =>
			Promise.resolve(listing({ path: path ?? "", parent: null })),
		);
		const picker = createDirPicker(browse);
		let seen = 0;
		const unsub = picker.subscribe(() => seen++);
		await picker.navigate("/");
		expect(seen).toBeGreaterThan(0);
		const at = seen;
		unsub();
		await picker.navigate("/");
		expect(seen).toBe(at);
	});
});
