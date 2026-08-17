/** Formatting helpers + hash-route encoding. */

/** Human duration, e.g. 342 ms / 1.2 s / 3 min 5 s / 1 hr 2 min. */
export function formatMs(ms: number | null | undefined): string {
	if (ms === null || ms === undefined || Number.isNaN(ms)) return "—";
	if (ms < 1000) return `${Math.round(ms)} ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
	if (ms < 3_600_000) {
		const m = Math.floor(ms / 60_000);
		const s = Math.round((ms % 60_000) / 1000);
		return `${m} min ${s} s`;
	}
	const h = Math.floor(ms / 3_600_000);
	const m = Math.round((ms % 3_600_000) / 60_000);
	return `${h} hr ${m} min`;
}

/** Compact counts: 1.2k, 3.4M. */
export function formatCompact(n: number | null | undefined): string {
	if (n === null || n === undefined || Number.isNaN(n)) return "—";
	if (Math.abs(n) >= 1_000_000)
		return `${(n / 1_000_000).toFixed(Math.abs(n) >= 10_000_000 ? 0 : 1)}M`;
	if (Math.abs(n) >= 10_000) return `${Math.round(n / 1000)}k`;
	if (Math.abs(n) >= 1_000) return `${(n / 1000).toFixed(1)}k`;
	return String(Math.round(n));
}

/** Dollar amount with enough precision to stay meaningful at small values. */
export function formatCost(cost: number | null | undefined): string {
	if (cost === null || cost === undefined || Number.isNaN(cost)) return "—";
	if (cost === 0) return "$0.00";
	const digits = cost >= 100 ? 0 : cost >= 1 ? 2 : cost >= 0.01 ? 4 : 5;
	return `$${cost.toFixed(digits)}`;
}

export function formatBytes(n: number | null | undefined): string {
	if (n === null || n === undefined || Number.isNaN(n)) return "—";
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Relative time, e.g. "3 min ago", "2 day ago". */
export function timeAgo(ts: number | null | undefined): string {
	if (ts === null || ts === undefined || Number.isNaN(ts)) return "—";
	const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
	if (s < 10) return "just now";
	if (s < 60) return `${s} sec ago`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m} min ago`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h} hr ago`;
	const d = Math.floor(h / 24);
	if (d < 7) return `${d} day${d === 1 ? "" : "s"} ago`;
	const w = Math.floor(d / 7);
	if (w < 5) return `${w} wk ago`;
	const mo = Math.floor(d / 30);
	if (mo < 12) return `${mo} mo ago`;
	return `${Math.floor(d / 365)} yr ago`;
}

export function formatDateTime(ts: number | null | undefined): string {
	if (ts === null || ts === undefined || Number.isNaN(ts)) return "—";
	return new Date(ts).toLocaleString();
}

/** Last path segment (file name). */
export function basename(file: string): string {
	const parts = file.split("/");
	return parts[parts.length - 1] ?? file;
}

/** First path segment (project dir name). */
export function folderOf(file: string): string {
	const parts = file.split("/");
	return parts.length > 1 ? (parts[0] ?? "") : "";
}

/** Encode each `/`-separated path segment, keeping the separators literal — used for API `:file` URL params and hash routes alike. */
export function encodePathSegments(file: string): string {
	return file
		.split("/")
		.map((seg) => encodeURIComponent(seg))
		.join("/");
}

/** Hash-route decoding; null on malformed input. */
export function decodeFileFromHash(encoded: string): string | null {
	try {
		return encoded
			.split("/")
			.map((seg) => decodeURIComponent(seg))
			.join("/");
	} catch {
		return null;
	}
}
