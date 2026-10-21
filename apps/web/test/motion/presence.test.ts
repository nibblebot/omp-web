import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	mock,
	test,
	vi,
} from "bun:test";
import * as solid from "solid-js";
import type * as PresenceModule from "../../motion/presence";

// bun resolves "solid-js" to its SSR build (effects never run); the client
// build gives createPresence a live reactive scope. Same technique as
// ModalHost.test.ts: mock it for this suite, restore the originals afterwards.
const CLIENT_SOLID: string = "solid-js/dist/solid.js";
const originalSolid = { ...solid };

let afterMotion: typeof PresenceModule.afterMotion;
let createPresence: typeof PresenceModule.createPresence;
let createRoot: (fn: (dispose: () => void) => void) => void;
let createSignal: <T>(v: T) => [() => T, (v: T) => void];

interface Style {
	transitionProperty: string;
	transitionDuration: string;
	transitionDelay: string;
	animationName: string;
	animationDuration: string;
	animationDelay: string;
	animationIterationCount: string;
}

const NO_MOTION: Style = {
	transitionProperty: "all",
	transitionDuration: "0s",
	transitionDelay: "0s",
	animationName: "none",
	animationDuration: "0s",
	animationDelay: "0s",
	animationIterationCount: "1",
};

/** Minimal Element double: only what presence.ts reads. */
class FakeEl {
	isConnected = true;
	style: Style = { ...NO_MOTION };
	listeners = new Map<string, Set<(ev: Event) => void>>();
	addEventListener(type: string, fn: (ev: Event) => void): void {
		const set = this.listeners.get(type) ?? new Set();
		set.add(fn);
		this.listeners.set(type, set);
	}
	removeEventListener(type: string, fn: (ev: Event) => void): void {
		this.listeners.get(type)?.delete(fn);
	}
	listenerCount(): number {
		let n = 0;
		for (const set of this.listeners.values()) n += set.size;
		return n;
	}
	fire(type: string, target: unknown = this): void {
		for (const fn of [...(this.listeners.get(type) ?? [])]) fn({ target } as unknown as Event);
	}
}

function el(style: Partial<Style> = {}): FakeEl {
	const e = new FakeEl();
	e.style = { ...NO_MOTION, ...style };
	return e;
}

let frames: (() => void)[] = [];
const g = globalThis as unknown as Record<string, unknown>;
const saved: Record<string, unknown> = {};

function flushFrames(): void {
	const pending = frames;
	frames = [];
	for (const fn of pending) fn();
}

/** Lets already-resolved promise callbacks run. */
async function settle(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

/** Resolution state of a promise without awaiting it. */
function track(p: Promise<void>): { done: boolean } {
	const state = { done: false };
	void p.then(() => {
		state.done = true;
	});
	return state;
}

beforeAll(async () => {
	const clientSolid = { ...(await import(CLIENT_SOLID)) };
	mock.module("solid-js", () => clientSolid);
	createRoot = clientSolid.createRoot;
	createSignal = clientSolid.createSignal;
	// Dynamic import: the module must load AFTER the solid-js mock above, which a
	// static import cannot order; the query string bypasses the cached SSR-bound copy.
	const path: string = "../../motion/presence.ts?fresh=presence-test";
	({ afterMotion, createPresence } = await import(path));
});

afterAll(() => {
	mock.module("solid-js", () => originalSolid);
});

beforeEach(() => {
	vi.useFakeTimers();
	frames = [];
	for (const key of ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"]) {
		saved[key] = g[key];
	}
	g.getComputedStyle = (e: FakeEl) => e.style;
	g.requestAnimationFrame = (fn: () => void) => frames.push(fn);
	g.cancelAnimationFrame = (id: number) => {
		frames[id - 1] = () => {};
	};
});

afterEach(() => {
	vi.useRealTimers();
	for (const [key, value] of Object.entries(saved)) g[key] = value;
});

describe("afterMotion", () => {
	test("resolves immediately when the computed duration is 0", async () => {
		await afterMotion(el() as unknown as Element);
	});

	test("resolves immediately when the element is not rendered", async () => {
		const e = el({ transitionProperty: "opacity", transitionDuration: "5s" });
		e.isConnected = false;
		await afterMotion(e as unknown as Element);
	});

	test("resolves on the element's own transitionend and clears listeners", async () => {
		const e = el({ transitionProperty: "opacity", transitionDuration: "5s" });
		const p = track(afterMotion(e as unknown as Element));
		expect(e.listenerCount()).toBe(2);
		e.fire("transitionend");
		await settle();
		expect(p.done).toBe(true);
		expect(e.listenerCount()).toBe(0);
	});

	test("ignores end events bubbled from descendants", async () => {
		const e = el({ transitionProperty: "opacity", transitionDuration: "5s" });
		const p = track(afterMotion(e as unknown as Element));
		e.fire("transitionend", {});
		e.fire("animationend", {});
		await settle();
		expect(p.done).toBe(false);
		e.fire("animationend");
		await settle();
		expect(p.done).toBe(true);
	});

	test("falls back after max(duration + delay) + 50ms over comma lists", async () => {
		const e = el({
			transitionProperty: "opacity, transform",
			transitionDuration: "0.01s, 10ms",
			transitionDelay: "0s, 0.03s",
			animationName: "flash",
			animationDuration: "0.02s",
			animationDelay: "0s",
			animationIterationCount: "1",
		});
		const p = track(afterMotion(e as unknown as Element));
		// Longest is transform: 10ms + 30ms = 40ms, so the fallback lands at 90ms.
		vi.advanceTimersByTime(89);
		await settle();
		expect(p.done).toBe(false);
		vi.advanceTimersByTime(1);
		await settle();
		expect(p.done).toBe(true);
		expect(e.listenerCount()).toBe(0);
	});

	test("an infinite animation is not waited on", async () => {
		const e = el({
			animationName: "spin",
			animationDuration: "1s",
			animationIterationCount: "infinite",
		});
		await afterMotion(e as unknown as Element);
	});
});

interface Harness {
	e: FakeEl;
	open: (v: boolean) => void;
	presence: ReturnType<typeof createPresence>;
	dispose: () => void;
}

function mount(initial: boolean, style: Partial<Style> = {}): Harness {
	const e = el({ transitionProperty: "opacity", transitionDuration: "5s", ...style });
	let h!: Harness;
	createRoot((dispose) => {
		const [open, setOpen] = createSignal(initial);
		const presence = createPresence(open);
		presence.ref(e as unknown as HTMLElement);
		h = { e, open: setOpen, presence, dispose };
	});
	return h;
}

describe("createPresence", () => {
	test("starts unmounted in the hidden state when closed", () => {
		const h = mount(false);
		expect(h.presence.mounted()).toBe(false);
		expect(h.presence.phase()).toBe("exit");
		h.dispose();
	});

	test("open mounts in enter, then moves to open after two frames", () => {
		const h = mount(false);
		h.open(true);
		expect(h.presence.mounted()).toBe(true);
		expect(h.presence.phase()).toBe("enter");
		flushFrames();
		expect(h.presence.phase()).toBe("enter");
		flushFrames();
		expect(h.presence.phase()).toBe("open");
		h.dispose();
	});

	test("an initially open presence plays the enter motion", () => {
		const h = mount(true);
		expect(h.presence.mounted()).toBe(true);
		expect(h.presence.phase()).toBe("enter");
		flushFrames();
		flushFrames();
		expect(h.presence.phase()).toBe("open");
		h.dispose();
	});

	test("close goes to exit and unmounts after the element's motion ends", async () => {
		const h = mount(true);
		flushFrames();
		flushFrames();
		h.open(false);
		expect(h.presence.phase()).toBe("exit");
		expect(h.presence.mounted()).toBe(true);
		await Promise.resolve();
		expect(h.presence.mounted()).toBe(true);
		h.e.fire("transitionend");
		expect(h.presence.mounted()).toBe(false);
		expect(h.e.listenerCount()).toBe(0);
		h.dispose();
	});

	test("zero computed duration unmounts without waiting", async () => {
		const h = mount(true, { transitionDuration: "0s" });
		flushFrames();
		flushFrames();
		h.open(false);
		await Promise.resolve();
		expect(h.presence.mounted()).toBe(false);
		h.dispose();
	});

	test("reopening during exit returns to open without remount and drops the exit wait", async () => {
		const h = mount(true);
		flushFrames();
		flushFrames();
		h.open(false);
		await Promise.resolve();
		expect(h.e.listenerCount()).toBe(2);
		h.open(true);
		expect(h.presence.phase()).toBe("open");
		expect(h.presence.mounted()).toBe(true);
		expect(h.e.listenerCount()).toBe(0);
		h.e.fire("transitionend");
		expect(h.presence.mounted()).toBe(true);
		h.dispose();
	});

	test("closing during enter cancels the pending open frame and exits", async () => {
		const h = mount(false);
		h.open(true);
		h.open(false);
		expect(h.presence.phase()).toBe("exit");
		flushFrames();
		flushFrames();
		expect(h.presence.phase()).toBe("exit");
		await Promise.resolve();
		h.e.fire("animationend");
		expect(h.presence.mounted()).toBe(false);
		h.dispose();
	});

	test("disposing clears the exit listeners and timer", async () => {
		const h = mount(true);
		flushFrames();
		flushFrames();
		h.open(false);
		await Promise.resolve();
		expect(h.e.listenerCount()).toBe(2);
		h.dispose();
		expect(h.e.listenerCount()).toBe(0);
	});
});
