/**
 * Two-phase resume list (resume-adapter `phase`): the preliminary answer holds
 * only the rows history.db indexes a title for (file name, stat and title; no
 * cwd, first prompt or status), the complete answer is the full scan with empty
 * sessions dropped (pins kept), and the full scan writes the titles it read back
 * to history.db so the next open lists them at once. Every test points the agent
 * dir at a scratch dir, so the real `~/.omp/agent/history.db` is never touched.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	listSessionTitles,
	recordSessionTitles,
} from "@oh-my-pi/pi-coding-agent/session/session-index";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils";
import { cleanupTempDirs, tempDir } from "#lib/testkit/temp-dir.testkit";
import {
	createResumeHandlers,
	type ResumeListResult,
	type ResumePartialCandidate,
	toggleResumePin,
} from "../resume-adapter";

const previousEnv = process.env.PI_CODING_AGENT_DIR;
const previousDir = getAgentDir();
let agentDir = "";
beforeAll(() => {
	agentDir = tempDir("omp-resume-phases-agent-");
	setAgentDir(agentDir);
});
afterAll(() => {
	setAgentDir(previousDir);
	if (previousEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousEnv;
	cleanupTempDirs();
});

interface Journal {
	root: string;
	project: string;
	id: string;
	/** Title stored in the session file's own header (never in history.db until a scan reads it). */
	headerTitle?: string;
	userTexts?: string[];
	/** Age in minutes: later files list first (newest first). */
	ageMin?: number;
}

/** A listable session file `<root>/<project>/<stamp>_<id>.jsonl`, as the SDK names them. */
function journal(j: Journal): string {
	const dir = join(j.root, j.project);
	mkdirSync(dir, { recursive: true });
	const stamp = new Date().toISOString();
	const lines = [
		JSON.stringify({
			type: "session",
			version: 3,
			id: j.id,
			cwd: dir,
			timestamp: stamp,
			...(j.headerTitle !== undefined ? { title: j.headerTitle } : {}),
		}),
	];
	(j.userTexts ?? []).forEach((text, i) =>
		lines.push(
			JSON.stringify({
				type: "message",
				id: `m${i}`,
				parentId: i === 0 ? null : `m${i - 1}`,
				timestamp: stamp,
				message: { role: "user", content: [{ type: "text", text }] },
			}),
		),
	);
	const file = join(dir, `2026-11-01T10-00-00-000Z_${j.id}.jsonl`);
	writeFileSync(file, `${lines.join("\n")}\n`);
	const when = new Date(Date.now() - (j.ageMin ?? 0) * 60_000);
	utimesSync(file, when, when);
	return file;
}

/** One scratch sessions root with its own handlers (and so its own held scans). */
function scratch() {
	const root = tempDir("omp-resume-phases-root-");
	const local = join(root, "projA");
	const handlers = createResumeHandlers({
		cwd: local,
		sessionDir: local,
		sessionsRoot: root,
		agentDir,
	});
	const list = (arg: Record<string, unknown>) =>
		handlers.resumeList?.([arg]) as Promise<ResumeListResult>;
	return { root, local, list };
}

const ids = (result: ResumeListResult) => result.candidates.map((c) => c.id);

describe("preliminary phase", () => {
	test("lists only the indexed-title rows, without what a content read gives", async () => {
		const { root, list } = scratch();
		const indexed = crypto.randomUUID();
		const scannedOnly = crypto.randomUUID();
		const untitled = crypto.randomUUID();
		journal({ root, project: "projA", id: indexed, userTexts: ["indexed prompt"], ageMin: 3 });
		journal({
			root,
			project: "projA",
			id: scannedOnly,
			headerTitle: "Scanned only",
			userTexts: ["hello"],
			ageMin: 2,
		});
		journal({ root, project: "projA", id: untitled, userTexts: ["no title here"], ageMin: 1 });
		recordSessionTitles(new Map([[indexed, "Indexed title"]]));

		const preliminary = await list({ phase: "preliminary" });
		expect(preliminary.complete).toBe(false);
		expect(ids(preliminary)).toEqual([indexed]);
		const [row] = preliminary.candidates as ResumePartialCandidate[];
		expect(row).toMatchObject({ title: "Indexed title", partial: true, scope: "local" });
		for (const key of ["cwd", "firstMessage", "messageCount", "status"]) {
			expect(row).not.toHaveProperty(key);
		}

		const complete = await list({});
		expect(complete.complete).toBe(true);
		expect(ids(complete).sort()).toEqual([indexed, scannedOnly, untitled].sort());
		const full = complete.candidates.find((c) => c.id === indexed);
		expect(full).toMatchObject({ firstMessage: "indexed prompt" });
		expect(full).not.toHaveProperty("partial");
	});

	test("the full scan saves the titles it read, so the next open lists them at once", async () => {
		const { root, list } = scratch();
		const known = crypto.randomUUID();
		const legacy = crypto.randomUUID();
		journal({ root, project: "projA", id: known, headerTitle: "Known", userTexts: ["a"] });
		journal({ root, project: "projA", id: legacy, headerTitle: "Legacy title", userTexts: ["b"] });
		recordSessionTitles(new Map([[known, "Known"]]));
		expect(listSessionTitles().has(legacy)).toBe(false);

		await list({ phase: "preliminary" });
		await list({});
		expect(listSessionTitles().get(legacy)).toBe("Legacy title");

		const reopened = await list({ phase: "preliminary" });
		expect(ids(reopened).sort()).toEqual([known, legacy].sort());
		expect(reopened.complete).toBe(false);
	});

	test("with nothing indexed the preliminary answer is already the full list", async () => {
		const { root, list } = scratch();
		const id = crypto.randomUUID();
		journal({ root, project: "projA", id, userTexts: ["first prompt"] });

		const result = await list({ phase: "preliminary" });
		expect(result.complete).toBe(true);
		expect(result.candidates[0]).toMatchObject({ id, firstMessage: "first prompt" });
		expect(result.candidates[0]).not.toHaveProperty("partial");
	});

	test("keeps pinned-first, the limit, and the search over what the rows carry", async () => {
		const { root, list } = scratch();
		const newest = crypto.randomUUID();
		const middle = crypto.randomUUID();
		const pinnedOld = crypto.randomUUID();
		journal({ root, project: "projA", id: newest, userTexts: ["alpha"], ageMin: 1 });
		journal({ root, project: "projA", id: middle, userTexts: ["needle in the prompt"], ageMin: 2 });
		journal({ root, project: "projA", id: pinnedOld, userTexts: ["gamma"], ageMin: 30 });
		recordSessionTitles(
			new Map([
				[newest, "Newest work"],
				[middle, "Middle work"],
				[pinnedOld, "Pinned old work"],
			]),
		);
		await toggleResumePin(pinnedOld, agentDir);
		const pins = await list({ phase: "preliminary" });

		expect(pins.pinnedIds).toContain(pinnedOld);
		expect(ids(pins)).toEqual([pinnedOld, newest, middle]);
		expect(ids(await list({ phase: "preliminary", limit: 1 }))).toHaveLength(1);
		expect((await list({ phase: "preliminary", limit: 1 })).total).toBe(3);

		// A title matches in the preliminary rows; a word only the prompt holds does not, until the full list.
		expect(ids(await list({ phase: "preliminary", query: "middle work" }))).toEqual([middle]);
		expect(ids(await list({ phase: "preliminary", query: "needle" }))).toEqual([]);
		expect(ids(await list({ query: "needle" }))).toEqual([middle]);
	});

	test("every project's titled rows list at once, other projects labelled global", async () => {
		const { root, list } = scratch();
		const here = crypto.randomUUID();
		const there = crypto.randomUUID();
		journal({ root, project: "projA", id: here, userTexts: ["x"], ageMin: 2 });
		journal({ root, project: "projB", id: there, userTexts: ["y"], ageMin: 1 });
		recordSessionTitles(
			new Map([
				[here, "Here"],
				[there, "There"],
			]),
		);

		const local = await list({ phase: "preliminary" });
		expect(ids(local)).toEqual([here]);

		const all = await list({ phase: "preliminary", allProjects: true });
		expect(all.allProjects).toBe(true);
		expect(Object.fromEntries(all.candidates.map((c) => [c.id, c.scope]))).toEqual({
			[here]: "local",
			[there]: "global",
		});
	});
});

describe("complete phase", () => {
	test("drops an empty untitled session unless it is pinned", async () => {
		const { root, list } = scratch();
		const used = crypto.randomUUID();
		const empty = crypto.randomUUID();
		journal({ root, project: "projA", id: used, headerTitle: "Used", userTexts: ["hello"] });
		journal({ root, project: "projA", id: empty });
		recordSessionTitles(new Map([[used, "Used"]]));

		await list({ phase: "preliminary" });
		expect(ids(await list({}))).toEqual([used]);

		await toggleResumePin(empty, agentDir);
		await list({ phase: "preliminary" });
		expect(ids(await list({})).sort()).toEqual([used, empty].sort());
	});
});
