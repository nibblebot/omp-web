export interface HistoryStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

const KEY = "omp-web:history";
const MAX_ENTRIES = 100;

/**
 * Prompt history ring backed by localStorage. Entries are oldest→newest;
 * consecutive duplicates collapse and the ring caps at MAX_ENTRIES (oldest
 * dropped).
 */
export class PromptHistory {
	private entries: string[] = [];

	constructor(private storage: HistoryStorage = localStorage) {
		try {
			const raw = this.storage.getItem(KEY);
			if (raw) {
				const parsed: unknown = JSON.parse(raw);
				if (Array.isArray(parsed))
					this.entries = parsed.filter((e): e is string => typeof e === "string");
			}
		} catch {
			this.entries = [];
		}
	}

	get size(): number {
		return this.entries.length;
	}

	/** Newest-first snapshot of the stored entries (for the prompt history picker). */
	list(): string[] {
		return [...this.entries].reverse();
	}

	push(text: string): void {
		const trimmed = text.trim();
		if (!trimmed || this.entries[this.entries.length - 1] === trimmed) return;
		this.entries.push(trimmed);
		if (this.entries.length > MAX_ENTRIES)
			this.entries.splice(0, this.entries.length - MAX_ENTRIES);
		try {
			this.storage.setItem(KEY, JSON.stringify(this.entries));
		} catch {
			// Quota/serialization failure: history is best-effort.
		}
	}
}
