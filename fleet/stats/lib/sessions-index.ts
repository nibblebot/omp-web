/**
 * Session-directory indexing shared by /ctl/stats/sessions and
 * /ctl/stats/health. One walk definition so the health counter can never
 * drift from the list.
 */
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { isMainSession } from "../paths";

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

/** Number of main-agent sessions on disk (same walk the sessions list uses). */
export function countMainSessions(dir: string): number {
	return walkJsonl(dir).filter((abs) => isMainSession(relative(dir, abs))).length;
}
