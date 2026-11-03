/**
 * Resume list scope (resume-adapter.listResumeCandidates): without
 * `allProjects` only the local project dir is listed; with it every project
 * under the sessions root is listed, other projects' rows are "global", and the
 * search also matches conversation text beyond the first prompt.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils";
import { cleanupTempDirs, tempDir } from "#lib/testkit/temp-dir.testkit";
import { listResumeCandidates } from "../resume-adapter";

// The listing reads and writes the agent dir's history.db; keep it off the real one.
const previousEnv = process.env.PI_CODING_AGENT_DIR;
const previousDir = getAgentDir();
beforeAll(() => setAgentDir(tempDir("omp-scope-agent-")));
afterAll(() => {
	setAgentDir(previousDir);
	if (previousEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousEnv;
	cleanupTempDirs();
});

/** A listable journal (header + user turns) under `<root>/<project>/`. */
function journal(root: string, project: string, id: string, userTexts: string[]): void {
	const dir = join(root, project);
	mkdirSync(dir, { recursive: true });
	const now = new Date().toISOString();
	const lines = [JSON.stringify({ type: "session", version: 3, id, cwd: dir, timestamp: now })];
	userTexts.forEach((text, i) =>
		lines.push(
			JSON.stringify({
				type: "message",
				id: `m${i}`,
				parentId: i === 0 ? null : `m${i - 1}`,
				timestamp: now,
				message: { role: "user", content: [{ type: "text", text }] },
			}),
		),
	);
	writeFileSync(join(dir, `${id}.jsonl`), `${lines.join("\n")}\n`);
}

describe("listResumeCandidates scope", () => {
	test("without allProjects only the local project is listed as local", async () => {
		const root = tempDir("omp-scope-local-");
		const local = join(root, "projA");
		const idA = crypto.randomUUID();
		const idB = crypto.randomUUID();
		journal(root, "projA", idA, ["alpha prompt"]);
		journal(root, "projB", idB, ["beta prompt"]);

		const result = await listResumeCandidates({
			cwd: local,
			sessionDir: local,
			sessionsRoot: root,
			pinnedIds: new Set(),
		});

		expect(result.allProjects).toBe(false);
		expect(result.candidates.map((c) => c.id)).toEqual([idA]);
		expect(result.candidates[0]?.scope).toBe("local");
	});

	test("allProjects lists every project, labels other projects global, and searches conversation text", async () => {
		const root = tempDir("omp-scope-global-");
		const local = join(root, "projA");
		const idA = crypto.randomUUID();
		const idB = crypto.randomUUID();
		journal(root, "projA", idA, ["alpha prompt"]);
		journal(root, "projB", idB, ["alpha prompt", "needle deep in the conversation"]);

		const all = await listResumeCandidates({
			cwd: local,
			sessionDir: local,
			sessionsRoot: root,
			pinnedIds: new Set(),
			allProjects: true,
		});
		expect(all.allProjects).toBe(true);
		const scopes = Object.fromEntries(all.candidates.map((c) => [c.id, c.scope]));
		expect(scopes).toEqual({ [idA]: "local", [idB]: "global" });

		const searched = await listResumeCandidates({
			cwd: local,
			sessionDir: local,
			sessionsRoot: root,
			pinnedIds: new Set(),
			allProjects: true,
			query: "needle",
		});
		expect(searched.candidates.map((c) => c.id)).toEqual([idB]);
		expect(searched.candidates[0]?.scope).toBe("global");
	});

	test("an empty session is left out unless it is pinned", async () => {
		const root = tempDir("omp-scope-empty-");
		const local = join(root, "projA");
		const used = crypto.randomUUID();
		const empty = crypto.randomUUID();
		journal(root, "projA", used, ["alpha prompt"]);
		journal(root, "projA", empty, []);
		const list = (pinned: string[]) =>
			listResumeCandidates({ cwd: local, sessionDir: local, pinnedIds: new Set(pinned) });

		expect((await list([])).candidates.map((c) => c.id)).toEqual([used]);
		expect((await list([empty])).candidates.map((c) => c.id).sort()).toEqual([used, empty].sort());
	});
});
