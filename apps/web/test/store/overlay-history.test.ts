/**
 * Android Back vs overlays (store/overlay-history.ts): an open layer owns one
 * same-URL history entry, Back pops the topmost layer before any route
 * navigation, closing from the UI consumes the entry, and closing the dock from
 * its UI unwinds the entries it pushed so Back does not reopen it.
 *
 * The browser is a small history fake with real traversal semantics: pushState
 * drops forward entries, go() is asynchronous, popstate fires on every
 * traversal and hashchange only when the fragment differs.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { setState, state } from "../../state";
import { syncRouteToAttached } from "../../store/deep-link";
import { dismissDock, openDock, restoreDockLayout } from "../../store/dock";
import { installOverlayHistory, openOverlayLayer } from "../../store/overlay-history";
import {
	flushMicrotasks,
	installLocalStorageShim,
	restoreBrowserGlobals,
	setBrowserGlobal,
} from "../web.testkit";

interface Entry {
	url: string;
	state: unknown;
}

/** Browsers resolve the pushed URL; the fake keeps path + hash only. */
function relative(url: string | undefined): string | undefined {
	return url?.replace("http://localhost", "");
}

class FakeBrowser {
	entries: Entry[] = [{ url: "/#/w/d1/s/s1", state: null }];
	index = 0;
	hashchanges = 0;
	private listeners = new Map<string, Set<() => void>>();

	get hash(): string {
		return this.entries[this.index].url.split("#")[1] === undefined
			? ""
			: `#${this.entries[this.index].url.split("#")[1]}`;
	}
	readonly historyApi = {
		pushState: (state: unknown, _: string, url?: string) => {
			this.entries.splice(this.index + 1);
			this.entries.push({ url: relative(url) ?? this.entries[this.index].url, state });
			this.index++;
		},
		replaceState: (state: unknown, _: string, url?: string) => {
			this.entries[this.index] = { url: relative(url) ?? this.entries[this.index].url, state };
		},
		go: (delta: number) => queueMicrotask(() => this.traverse(delta)),
	};
	readonly window = {
		addEventListener: (type: string, fn: () => void) => this.listenersOf(type).add(fn),
		removeEventListener: (type: string, fn: () => void) => this.listenersOf(type).delete(fn),
	};

	private listenersOf(type: string): Set<() => void> {
		let set = this.listeners.get(type);
		if (set === undefined) this.listeners.set(type, (set = new Set()));
		return set;
	}

	/** The hardware Back button. */
	back(): void {
		this.traverse(-1);
	}

	private traverse(delta: number): void {
		const target = this.index + delta;
		if (target < 0 || target >= this.entries.length) return;
		const before = this.hash;
		this.index = target;
		for (const fn of this.listenersOf("popstate")) fn();
		if (this.hash !== before) {
			this.hashchanges++;
			for (const fn of this.listenersOf("hashchange")) fn();
		}
	}

	install(): void {
		const self = this;
		setBrowserGlobal("window", this.window as unknown as Window & typeof globalThis);
		setBrowserGlobal("location", {
			pathname: "/",
			search: "",
			origin: "http://localhost",
			get href() {
				return `http://localhost${self.entries[self.index].url}`;
			},
			get hash() {
				return self.hash;
			},
		} as unknown as Location);
		const api = this.historyApi;
		setBrowserGlobal("history", {
			pushState: api.pushState,
			replaceState: api.replaceState,
			go: api.go,
			get state() {
				return self.entries[self.index].state;
			},
		} as unknown as History);
	}
}

async function settle(): Promise<void> {
	for (let i = 0; i < 6; i++) await flushMicrotasks();
}

let browser: FakeBrowser;
let uninstall: () => void;
const open: (() => void)[] = [];

/** Register a layer; `closed` records Back-driven closes. */
function layer(name: string, closed: string[]): () => void {
	const dismiss = openOverlayLayer(() => closed.push(name));
	open.push(dismiss);
	return dismiss;
}

beforeEach(() => {
	installLocalStorageShim();
	browser = new FakeBrowser();
	browser.install();
	uninstall = installOverlayHistory();
	restoreDockLayout("__no-such-workspace__");
	setState({ currentWorkspaceId: "d1", sessionId: "s1", dock: null });
});

afterEach(async () => {
	for (const dismiss of open.splice(0)) dismiss();
	await settle();
	uninstall();
	restoreDockLayout("__no-such-workspace__");
	setState({ currentWorkspaceId: "", sessionId: "" });
	restoreBrowserGlobals();
});

describe("overlay layers", () => {
	test("opening a layer pushes one same-URL entry and fires no hashchange", async () => {
		layer("modal", []);
		await settle();
		expect(browser.entries.map((e) => e.url)).toEqual(["/#/w/d1/s/s1", "/#/w/d1/s/s1"]);
		expect(browser.index).toBe(1);
		expect(browser.hashchanges).toBe(0);
	});

	test("Back closes the topmost layer without touching the route", async () => {
		const closed: string[] = [];
		layer("modal", closed);
		await settle();
		browser.back();
		await settle();
		expect(closed).toEqual(["modal"]);
		expect(browser.index).toBe(0);
		expect(browser.hashchanges).toBe(0);
	});

	test("closing from the UI consumes the entry: history does not grow", async () => {
		const closed: string[] = [];
		const dismiss = layer("modal", closed);
		await settle();
		dismiss();
		await settle();
		expect(closed).toEqual([]);
		expect(browser.index).toBe(0);
		// A second open reuses the slot instead of stacking behind the dead one.
		layer("again", closed);
		await settle();
		expect(browser.entries).toHaveLength(2);
		expect(browser.index).toBe(1);
	});

	test("after a UI close, Back leaves the page route instead of eating a dead entry", async () => {
		browser.historyApi.pushState(null, "", "/#/w/d1/s/s0");
		browser.historyApi.pushState(null, "", "/#/w/d1/s/s1");
		const dismiss = layer("modal", []);
		await settle();
		dismiss();
		await settle();
		expect(browser.hash).toBe("#/w/d1/s/s1");
		browser.back();
		expect(browser.hash).toBe("#/w/d1/s/s0");
		expect(browser.hashchanges).toBe(1);
	});

	test("nested layers unwind one per Back, then Back navigates", async () => {
		browser.historyApi.pushState(null, "", "/#/w/d1/s/s2");
		const closed: string[] = [];
		layer("sheet", closed);
		await settle();
		layer("dialog", closed);
		await settle();
		expect(browser.entries).toHaveLength(4);

		browser.back();
		await settle();
		expect(closed).toEqual(["dialog"]);
		browser.back();
		await settle();
		expect(closed).toEqual(["dialog", "sheet"]);
		expect(browser.hashchanges).toBe(0);

		browser.back();
		expect(browser.hash).toBe("#/w/d1/s/s1");
		expect(browser.hashchanges).toBe(1);
		expect(closed).toEqual(["dialog", "sheet"]);
	});

	test("dismissing a lower layer first keeps the upper one reachable by Back", async () => {
		const closed: string[] = [];
		const lower = layer("drawer", closed);
		await settle();
		layer("modal", closed);
		await settle();
		lower();
		await settle();
		browser.back();
		await settle();
		expect(closed).toEqual(["modal"]);
		expect(browser.index).toBe(0);
	});

	test("swapping one layer for another in the same tick leaves history alone", async () => {
		const first = layer("settings", []);
		await settle();
		const length = browser.entries.length;
		first();
		layer("login", []);
		await settle();
		expect(browser.entries).toHaveLength(length);
		expect(browser.index).toBe(1);
	});

	test("a route write while a layer is open lands on the base entry; the layer keeps one entry above it", async () => {
		const closed: string[] = [];
		const dismiss = layer("modal", closed);
		await settle();
		setState("sessionId", "s2");
		syncRouteToAttached();
		await settle();
		expect(browser.hash).toBe("#/w/d1/s/s2");
		// base s1, pushed s2, sentinel above it
		expect(browser.entries.map((e) => e.url).slice(0, 2)).toEqual(["/#/w/d1/s/s1", "/#/w/d1/s/s2"]);
		expect(browser.index).toBe(2);
		dismiss();
		await settle();
		expect(browser.hash).toBe("#/w/d1/s/s2");
		expect(browser.index).toBe(1);
		expect(closed).toEqual([]);
	});
});

describe("closing the dock from its UI", () => {
	test("unwinds the entry the dock pushed, so Back does not reopen it", async () => {
		openDock("review");
		syncRouteToAttached();
		await settle();
		expect(browser.hash).toBe("#/w/d1/s/s1/review");
		expect(browser.index).toBe(1);

		dismissDock();
		syncRouteToAttached(); // the App effect that mirrors state.dock into the URL
		await settle();
		expect(state.dock).toBeNull();
		expect(browser.hash).toBe("#/w/d1/s/s1");
		expect(browser.index).toBe(0);
		expect(browser.entries).toHaveLength(2); // nothing pushed on top of the closed dock
	});

	test("unwinds every entry a run of dock steps pushed", async () => {
		openDock("review");
		syncRouteToAttached();
		await settle();
		openDock("activities");
		syncRouteToAttached();
		await settle();
		expect(browser.index).toBe(2);

		dismissDock();
		syncRouteToAttached();
		await settle();
		expect(browser.hash).toBe("#/w/d1/s/s1");
		expect(browser.index).toBe(0);
	});

	test("a dock whose entry is not part of a push run closes by rewriting its entry", async () => {
		browser.entries[0] = { url: "/#/w/d1/s/s1/review", state: null };
		openDock("review");
		dismissDock();
		syncRouteToAttached();
		await settle();
		expect(browser.hash).toBe("#/w/d1/s/s1");
		expect(browser.entries).toHaveLength(1);
		expect(browser.index).toBe(0);
	});

	test("a dock opened from a popover (its entry still on top) still unwinds on close", async () => {
		const dismiss = layer("popover", []);
		await settle();
		openDock("activities");
		syncRouteToAttached();
		dismiss(); // the popover unmounts as the dock opens
		await settle();
		expect(browser.hash).toBe("#/w/d1/s/s1/activities");
		expect(browser.index).toBe(1);

		dismissDock();
		syncRouteToAttached();
		await settle();
		expect(browser.hash).toBe("#/w/d1/s/s1");
		expect(browser.index).toBe(0);
		expect(browser.entries).toHaveLength(2);
	});

	test("a dock opened on a fresh hash is its own entry: UI close steps back onto the session, one Back leaves it", async () => {
		browser.entries[0] = { url: "/", state: null };
		openDock("activities");
		syncRouteToAttached();
		await settle();
		expect(browser.entries.map((e) => e.url)).toEqual([
			"/",
			"/#/w/d1/s/s1",
			"/#/w/d1/s/s1/activities",
		]);
		expect(browser.index).toBe(2);

		dismissDock();
		syncRouteToAttached();
		await settle();
		expect(state.dock).toBeNull();
		expect(browser.hash).toBe("#/w/d1/s/s1");
		expect(browser.index).toBe(1);
		expect(browser.entries).toHaveLength(3); // no entry added by the close

		browser.back();
		expect(browser.hash).toBe("");
		expect(browser.index).toBe(0);
	});
});
