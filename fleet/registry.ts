/**
 * Daemon registry for the omp-fleet: the persistent, insertion-ordered
 * roster of daemons (spawned, attached, remote) with monotonic `dN` id
 * allocation that survives restarts.
 *
 * State is a JSON file `{ "nextId": number, "entries": RegistryEntry[] }` —
 * the path is injectable for tests; the fleet server resolves
 * `OMP_FLEET_STATE` / `~/.omp/fleet/state.json` and passes it
 * in. Every mutation is persisted atomically (write a sibling tmp file, then
 * rename over the real one) before the mutation returns, and fires
 * `onChange` (set by the edge server for roster broadcasts).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { DaemonEntry, DaemonStatus } from "../src/protocol";

/** A roster entry: DaemonEntry plus fleet-side registration data. */
export interface RegistryEntry extends DaemonEntry {
	/** Current git branch of the session cwd for local entries; set by the supervisor's git-state polling. */
	branch?: string;
	/** git dirty-state file counts; set by the supervisor's git-state polling (absent until the first successful probe). */
	git?: { added: number; modified: number; deleted: number; untracked: number };
	/** Remote/attached: the ws(s)://host:port as registered. */
	endpoint?: string;
	/** Bearer token for dial-in (R14). */
	token?: string;
	/** Spawned entries: the template name they were spawned from. */
	template?: string;
	registeredAt: number;
}

/** On-disk shape of state.json. */
interface RegistryFile {
	nextId: number;
	entries: RegistryEntry[];
}

export class Registry {
	/** Fired after every mutation (not on load); set by the edge server for roster broadcasts. */
	onChange: (() => void) | null = null;

	private readonly statePath: string;
	private entries: RegistryEntry[] = [];
	private nextId = 1;

	constructor(statePath: string) {
		this.statePath = statePath;
	}

	/** Missing file → empty registry. Corrupt file → throws with the path in the message. */
	async load(): Promise<void> {
		if (!existsSync(this.statePath)) {
			this.entries = [];
			this.nextId = 1;
			return;
		}
		const file = this.#readFile();
		let maxIndex = 0;
		for (const entry of file.entries) {
			if (typeof entry !== "object" || entry === null || typeof entry.daemonId !== "string") {
				throw new Error(`registry state corrupt at ${this.statePath}: entry missing daemonId`);
			}
			const n = Number.parseInt(entry.daemonId.slice(1), 10);
			if (Number.isFinite(n) && n > maxIndex) maxIndex = n;
		}
		this.entries = [...file.entries];
		// Never reuse ids: floor the counter above the highest id on disk.
		this.nextId = Math.max(file.nextId, maxIndex + 1);
	}

	/** Atomic persist (tmp + rename). Mutations persist internally; this is the public API. */
	async save(): Promise<void> {
		this.#persist();
	}

	/** Insertion order. */
	list(): RegistryEntry[] {
		return [...this.entries];
	}

	get(daemonId: string): RegistryEntry | undefined {
		return this.entries.find((entry) => entry.daemonId === daemonId);
	}

	create(init: Omit<RegistryEntry, "daemonId" | "registeredAt" | "status"> & { status?: DaemonStatus }): RegistryEntry {
		const entry: RegistryEntry = {
			...init,
			daemonId: `d${this.nextId++}`,
			registeredAt: Date.now(),
			status: init.status ?? "spawning",
		};
		this.entries.push(entry);
		this.#mutated();
		return entry;
	}

	update(daemonId: string, patch: Partial<RegistryEntry>): RegistryEntry {
		const index = this.#indexOf(daemonId);
		const entry = { ...this.entries[index], ...patch };
		this.entries[index] = entry;
		this.#mutated();
		return entry;
	}

	/**
	 * Sets the status; the `error` field is only carried while status is
	 * "error" and is cleared on every other transition (or when no message
	 * is supplied).
	 */
	setStatus(daemonId: string, status: DaemonStatus, error?: string): void {
		const entry = this.#require(daemonId);
		entry.status = status;
		if (status === "error") {
			if (error === undefined) delete entry.error;
			else entry.error = error;
		} else {
			delete entry.error;
		}
		this.#mutated();
	}

	remove(daemonId: string): boolean {
		const index = this.entries.findIndex((entry) => entry.daemonId === daemonId);
		if (index === -1) return false;
		this.entries.splice(index, 1);
		this.#mutated();
		return true;
	}

	#readFile(): RegistryFile {
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(this.statePath, "utf8"));
		} catch (err) {
			throw new Error(`registry state corrupt at ${this.statePath}: ${(err as Error).message}`);
		}
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			throw new Error(`registry state corrupt at ${this.statePath}: expected an object`);
		}
		const file = parsed as Partial<RegistryFile>;
		if (typeof file.nextId !== "number" || !Array.isArray(file.entries)) {
			throw new Error(`registry state corrupt at ${this.statePath}: missing nextId or entries`);
		}
		return file as RegistryFile;
	}

	#indexOf(daemonId: string): number {
		const index = this.entries.findIndex((entry) => entry.daemonId === daemonId);
		if (index === -1) throw new Error(`unknown daemon id: ${daemonId}`);
		return index;
	}

	#require(daemonId: string): RegistryEntry {
		return this.entries[this.#indexOf(daemonId)];
	}

	/** Persist atomically, then notify. Called after every mutation. */
	#mutated(): void {
		this.#persist();
		this.onChange?.();
	}

	#persist(): void {
		mkdirSync(dirname(this.statePath), { recursive: true });
		const payload = JSON.stringify({ nextId: this.nextId, entries: this.entries } satisfies RegistryFile);
		const tmp = `${this.statePath}.tmp`;
		writeFileSync(tmp, payload, "utf8");
		renameSync(tmp, this.statePath);
	}
}
