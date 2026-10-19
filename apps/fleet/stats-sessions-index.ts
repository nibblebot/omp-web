/**
 * Session-directory walk for /ctl/stats/sessions. The list cache builds its
 * rows from this walk; /ctl/stats/health reads its count from that cache.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";

/** All *.jsonl files under dir, absolute paths (unreadable dirs skipped). */
export function walkJsonl(dir: string): string[] {
	const out: string[] = [];
	const stack = [dir];
	while (stack.length > 0) {
		const d = stack.pop()!;
		let entries;
		try {
			entries = readdirSync(d, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const e of entries) {
			const p = join(d, e.name);
			if (e.isDirectory()) stack.push(p);
			else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
		}
	}
	return out;
}
