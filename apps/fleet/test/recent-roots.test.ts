import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listRecentRoots } from "../recent-roots";

/** A session log whose header records `cwd`, last touched at `mtimeSec`. */
function writeSession(
	sessions: string,
	project: string,
	name: string,
	cwd: string,
	mtimeSec: number,
) {
	const dir = join(sessions, project);
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `${name}.jsonl`);
	writeFileSync(file, `${JSON.stringify({ type: "session", id: name, cwd })}\n`);
	utimesSync(file, mtimeSec, mtimeSec);
}

describe("listRecentRoots", () => {
	let root: string;
	let sessions: string;
	let repoA: string;
	let repoB: string;
	let plain: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "recent-roots-"));
		sessions = join(root, "agent", "sessions");
		repoA = join(root, "a");
		repoB = join(root, "b");
		plain = join(root, "plain");
		for (const repo of [repoA, repoB]) mkdirSync(join(repo, ".git"), { recursive: true });
		mkdirSync(join(repoA, "src"), { recursive: true });
		mkdirSync(plain, { recursive: true });
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	test("orders by most recent session and maps a subdirectory cwd to its Git root", async () => {
		writeSession(sessions, "p-a", "2026-01-01T00-00-00", join(repoA, "src"), 1000);
		writeSession(sessions, "p-b", "2026-01-02T00-00-00", repoB, 2000);

		const roots = await listRecentRoots({ sessionsDir: sessions });
		expect(roots).toEqual([
			{ path: repoB, registered: false },
			{ path: repoA, registered: false },
		]);
	});

	test("skips non-Git and vanished cwds and lists each root once", async () => {
		writeSession(sessions, "p-plain", "2026-01-03T00-00-00", plain, 3000);
		writeSession(sessions, "p-gone", "2026-01-04T00-00-00", join(root, "gone"), 4000);
		writeSession(sessions, "p-b-new", "2026-01-05T00-00-00", repoB, 5000);
		writeSession(sessions, "p-b-old", "2026-01-01T00-00-00", repoB, 500);

		const roots = await listRecentRoots({ sessionsDir: sessions });
		expect(roots.map((r) => r.path)).toEqual([repoB]);
	});

	test("merges registered roots after the recent ones and flags them", async () => {
		writeSession(sessions, "p-b", "2026-01-02T00-00-00", repoB, 2000);
		const registeredOnly = join(root, "registered-only");

		const roots = await listRecentRoots({
			sessionsDir: sessions,
			registered: [repoA, registeredOnly, repoB],
		});
		expect(roots).toEqual([
			{ path: repoB, registered: true },
			{ path: repoA, registered: true },
			{ path: registeredOnly, registered: true },
		]);
	});

	test("respects the limit across recent and registered roots", async () => {
		writeSession(sessions, "p-a", "2026-01-01T00-00-00", repoA, 1000);
		writeSession(sessions, "p-b", "2026-01-02T00-00-00", repoB, 2000);

		const roots = await listRecentRoots({ sessionsDir: sessions, registered: [plain], limit: 1 });
		expect(roots).toEqual([{ path: repoB, registered: false }]);
	});

	test("a missing sessions dir yields only the registered roots", async () => {
		expect(await listRecentRoots({ sessionsDir: join(root, "nope") })).toEqual([]);
		expect(await listRecentRoots({ sessionsDir: join(root, "nope"), registered: [repoA] })).toEqual(
			[{ path: repoA, registered: true }],
		);
	});
});
