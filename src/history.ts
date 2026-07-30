export interface HistoryStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

const KEY = "omp-web:history";
const MAX_ENTRIES = 100;

/**
 * Prompt history ring backed by localStorage. Entries are oldest→newest;
 * consecutive duplicates collapse and the ring caps at MAX_ENTRIES (oldest
 * dropped). Browsing: prev() recalls older entries, next() moves back toward
 * the in-progress draft, which is stashed when browsing starts.
 */
export class PromptHistory {
	private entries: string[] = [];
	private cursor: number | null = null;
	private draft = "";

	constructor(private storage: HistoryStorage = localStorage) {
		try {
			const raw = this.storage.getItem(KEY);
			if (raw) {
				const parsed: unknown = JSON.parse(raw);
				if (Array.isArray(parsed)) this.entries = parsed.filter((e): e is string => typeof e === "string");
			}
		} catch {
			this.entries = [];
		}
	}

	get size(): number {
		return this.entries.length;
	}

	get browsing(): boolean {
		return this.cursor !== null;
	}

	push(text: string): void {
		const trimmed = text.trim();
		if (!trimmed || this.entries[this.entries.length - 1] === trimmed) {
			this.reset();
			return;
		}
		this.entries.push(trimmed);
		if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);
		try {
			this.storage.setItem(KEY, JSON.stringify(this.entries));
		} catch {
			// Quota/serialization failure: history is best-effort.
		}
		this.reset();
	}

	/** Recall an older entry; stashes the current draft on first browse. */
	prev(current: string): string | null {
		if (this.entries.length === 0) return null;
		if (this.cursor === null) {
			this.draft = current;
			this.cursor = this.entries.length - 1;
		} else {
			this.cursor = Math.max(0, this.cursor - 1);
		}
		return this.entries[this.cursor] ?? null;
	}

	/** Move toward newer entries; past the newest restores the stashed draft. */
	next(): string | null {
		if (this.cursor === null) return null;
		if (this.cursor + 1 >= this.entries.length) {
			this.cursor = null;
			return this.draft;
		}
		this.cursor += 1;
		return this.entries[this.cursor] ?? null;
	}

	reset(): void {
		this.cursor = null;
		this.draft = "";
	}
}
