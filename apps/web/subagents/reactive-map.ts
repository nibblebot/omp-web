import { batch, createSignal, getListener, type Setter } from "solid-js";

type Trigger = [track: () => void, fire: () => void];

function createTrigger(): Trigger {
	const [track, set] = createSignal(undefined, { equals: false });
	return [() => void track(), () => (set as Setter<undefined>)(undefined)];
}

/**
 * A Map that is updated in place and still reactive: `get`/`has` track one key, iteration, `size`
 * and `version` track the whole map, and every write fires only the readers it can affect. Solid
 * does not wrap Map values, so a plain Map in the store notifies readers only when the whole
 * property is replaced (a copy per write, and every reader reruns); this one never needs replacing.
 *
 * Write through the normal Map methods. A value stored under a key is an immutable snapshot:
 * replace it (`set`) to notify its readers, never mutate it. Construct empty and use `from`; the
 * Map constructor would call the overridden `set` before the trackers exist.
 */
export class ReactiveMap<K, V> extends Map<K, V> {
	readonly #keys = new Map<K, Trigger>();
	readonly #whole = createTrigger();
	#version = 0;

	static from<K, V>(entries: Iterable<readonly [K, V]>): ReactiveMap<K, V> {
		const map = new ReactiveMap<K, V>();
		for (const [key, value] of entries) map.set(key, value);
		return map;
	}

	/** Bumped by every write; read it to depend on the whole map's contents. */
	get version(): number {
		this.#whole[0]();
		return this.#version;
	}

	#key(key: K): Trigger | undefined {
		// Only readers that can subscribe need a trigger.
		if (getListener() === null) return this.#keys.get(key);
		let trigger = this.#keys.get(key);
		if (trigger === undefined) {
			trigger = createTrigger();
			this.#keys.set(key, trigger);
		}
		return trigger;
	}

	override get(key: K): V | undefined {
		this.#key(key)?.[0]();
		return super.get(key);
	}

	override has(key: K): boolean {
		this.#key(key)?.[0]();
		return super.has(key);
	}

	override get size(): number {
		this.#whole[0]();
		return super.size;
	}

	override set(key: K, value: V): this {
		const had = super.has(key);
		if (had && super.get(key) === value) return this;
		super.set(key, value);
		this.#version += 1;
		batch(() => {
			this.#keys.get(key)?.[1]();
			this.#whole[1]();
		});
		return this;
	}

	override delete(key: K): boolean {
		const had = super.delete(key);
		if (!had) return false;
		this.#version += 1;
		batch(() => {
			this.#keys.get(key)?.[1]();
			this.#whole[1]();
		});
		return true;
	}

	override clear(): void {
		if (super.size === 0) return;
		const keys = [...super.keys()];
		super.clear();
		this.#version += 1;
		batch(() => {
			for (const key of keys) this.#keys.get(key)?.[1]();
			this.#whole[1]();
		});
	}

	override forEach(callback: (value: V, key: K, map: Map<K, V>) => void, thisArg?: unknown): void {
		this.#whole[0]();
		super.forEach(callback, thisArg);
	}

	override keys(): MapIterator<K> {
		this.#whole[0]();
		return super.keys();
	}

	override values(): MapIterator<V> {
		this.#whole[0]();
		return super.values();
	}

	override entries(): MapIterator<[K, V]> {
		this.#whole[0]();
		return super.entries();
	}

	override [Symbol.iterator](): MapIterator<[K, V]> {
		this.#whole[0]();
		return super[Symbol.iterator]();
	}
}
