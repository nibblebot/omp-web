/**
 * /ctl/stored read surface (fleet/stored-sessions.ts): route dispatch
 * for all four routes, the frozen typed error envelope
 * { error: { code, message } }, the reserved-name guard, transcript
 * parsed/raw paging (including the last page at EOF), the readStoredPrefix
 * byte cap, and the key safety property: browsing stored history never wakes
 * compute.
 *
 * Everything runs against a REAL FleetLogStore over a per-suite tempDir
 * (lib/testkit/temp-dir.testkit tempDir/cleanupTempDirs, afterAll registered here) seeded
 * through the real ingest critical section; the app is driven in-process
 * (dispatchRequest, no HTTP server) exactly like the stats app tests. The
 * final suite boots a real fleet (server.testkit startTestFleet) over a
 * stored-only workspace to prove the routes cannot spawn, respawn, or touch a
 * daemon pair.
 *
 * Assertions are the frozen wire contract only: status, envelope, wire rows,
 * exact stored bytes, and page offsets. Store internals (index framing, the
 * in-memory stream map) are never pinned.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
	StoredSessionDetail,
	StoredSessionsResponse,
	StoredWorkspacesResponse,
	TranscriptPage,
} from "#lib/wire/stats-types";
import { cleanupTempDirs, tempDir } from "#lib/testkit/temp-dir.testkit";
import { FleetLogStore, type LogChunk } from "../log-store";
import {
	createStoredApp,
	toPublicProvenance,
	type ProvenanceLike,
	type StoredApp,
} from "../stored-sessions";
import { readStoredHead } from "../stats-store-index";
import { SESSION_HEAD_BYTES } from "../session-head";
import { fleetPaths, startTestFleet } from "./server.testkit";
import type { FleetServer } from "../server";

afterAll(cleanupTempDirs);

const WS_LIVE = "ws-live";
const WS_ORPHAN = "ws-orphan";
const WS_VERIFIED = "ws-verified";

const SESS_ALPHA = "sess-alpha";
const SESS_BETA = "sess-beta";
const SESS_PAGES = "sess-pages";
const SESS_NOMAIN = "sess-nomain";
const SESS_EMPTY = "sess-empty";
const SESS_GAMMA = "sess-gamma";
const SESS_RO = "sess-ro";

/** One newline-terminated JSONL record. */
const line = (value: unknown): string => `${JSON.stringify(value)}\n`;

const ALPHA_MAIN =
	line({ type: "title", title: "Stored Title" }) +
	line({ type: "session", id: SESS_ALPHA, cwd: "/srv/alpha", title: "Alpha Header" }) +
	line({ type: "message", id: "a1", timestamp: 1000 }) +
	line({ type: "message", id: "a2", timestamp: 2000 });
/** Subagent transcript: one corrupt line, no trailing newline. */
const SUB_ONE = line({ type: "message", id: "s1", timestamp: 1500 }) + "corrupt-not-json";
const ADVISOR = line({ type: "message", id: "adv1", timestamp: 1200 });
const NOTES = "plain notes, not jsonl\n";
/** Written to disk AFTER load(): unindexed metadata (crash-window shape). */
const MANUAL = "manual note\n";

const BETA_MAIN =
	line({ type: "session", id: SESS_BETA, cwd: "/srv/beta", title: "Beta Header" }) +
	line({ type: "message", id: "b1", timestamp: 5000 });

/** 601 lines: header + 600 messages, so paging spans several capped pages. */
const PAGES_MAIN =
	line({ type: "session", id: SESS_PAGES, cwd: "/srv/pages" }) +
	Array.from({ length: 600 }, (_, i) =>
		line({ type: "message", id: `p${i + 1}`, timestamp: i + 1 }),
	).join("");
const PAGES_LINES = 601;

const GAMMA_MAIN =
	line({ type: "session", id: SESS_GAMMA, cwd: "/srv/gamma", title: "Gamma Header" }) +
	line({ type: "message", id: "g1", timestamp: 3000 });

const EXTRA = line({ type: "message", id: "e1", timestamp: 4000 });

const utf8 = (s: string): number => Buffer.byteLength(s, "utf8");
const bytesOf = (...parts: string[]): number => parts.reduce((sum, p) => sum + utf8(p), 0);

/** Chunk wrapping exact raw bytes at `offset` under generation 1. */
function chunkAt(offset: number, content: string, eof = false): LogChunk {
	return { offset, generation: 1, data: Buffer.from(content, "utf8").toString("base64"), eof };
}

const PROVENANCE: Record<string, ProvenanceLike> = {
	[WS_LIVE]: {
		projectId: "p-live",
		kind: "clone",
		profileId: "prof-1",
		// A clone source must never reach the wire (only its kind does).
		source: { remote: "https://example.invalid/private-repo.git" },
	},
	[WS_VERIFIED]: {
		projectId: "p-verified",
		kind: "worktree",
		branch: "feat-1",
		pinnedRevision: "abc123",
		source: { local: "/srv/secret-origin" },
	},
};

let rootDir: string;
let store: FleetLogStore;
let app: StoredApp;

beforeAll(() => {
	rootDir = tempDir("omp-stored-sessions-");
	const seeder = new FleetLogStore({ rootDir });
	const ingest = (
		ws: string,
		session: string,
		relpath: string,
		content: string,
		eof = true,
	): void => {
		const result = seeder.ingest(ws, session, relpath, chunkAt(0, content, eof));
		expect(result.status).toBe("acked");
	};

	ingest(WS_LIVE, SESS_ALPHA, "sess-alpha.jsonl", ALPHA_MAIN);
	ingest(WS_LIVE, SESS_ALPHA, "sess-alpha/sub-one.jsonl", SUB_ONE, false);
	ingest(WS_LIVE, SESS_ALPHA, "sess-alpha/__advisor.jsonl", ADVISOR);
	ingest(WS_LIVE, SESS_ALPHA, "notes.txt", NOTES);
	ingest(WS_LIVE, SESS_BETA, "sess-beta.jsonl", BETA_MAIN);
	ingest(WS_LIVE, SESS_PAGES, "sess-pages.jsonl", PAGES_MAIN);
	// Metadata-only session: no main transcript exists.
	ingest(WS_LIVE, SESS_NOMAIN, "notes.txt", NOTES);
	// Indexed main with zero bytes: the head enrichment has nothing to read.
	ingest(WS_LIVE, SESS_EMPTY, "sess-empty.jsonl", "");
	ingest(WS_ORPHAN, SESS_GAMMA, "sess-gamma.jsonl", GAMMA_MAIN);
	ingest(WS_VERIFIED, SESS_RO, "sess-ro.jsonl", ALPHA_MAIN);
	ingest(WS_VERIFIED, SESS_RO, "sess-ro/extra.jsonl", EXTRA);
	seeder.markWorkspaceReadOnly(WS_VERIFIED);
	// The main vanished after the index recorded it: a "missing" asset.
	unlinkSync(join(rootDir, WS_VERIFIED, SESS_RO, "sess-ro.jsonl"));

	// The app sees what a booting fleet sees: state rebuilt from disk.
	store = FleetLogStore.load(rootDir);
	// An unindexed file appears after load (the crash window between append
	// and index rename): the read model must list it without adopting or
	// repairing anything, so its ackedBytes stays 0. Nested under the main
	// stem, the artifact-subtree layout.
	mkdirSync(join(rootDir, WS_LIVE, SESS_ALPHA, SESS_ALPHA), { recursive: true });
	writeFileSync(join(rootDir, WS_LIVE, SESS_ALPHA, SESS_ALPHA, "manual-note.txt"), MANUAL);

	app = createStoredApp({ store, provenance: (workspaceId) => PROVENANCE[workspaceId] });
});

const get = (path: string): Promise<Response | null> =>
	app.handleFetch(new Request(`http://localhost${path}`), new URL(`http://localhost${path}`));

const enc = (value: string): string => encodeURIComponent(value);

describe("stored route dispatch", () => {
	test("unowned paths and non-GET methods return null for the control plane", async () => {
		expect(await get("/ctl/stored")).toBeNull();
		expect(await get("/ctl/stored/nope")).toBeNull();
		const posted = await app.handleFetch(
			new Request("http://localhost/ctl/stored/sessions", { method: "POST" }),
			new URL("http://localhost/ctl/stored/sessions"),
		);
		expect(posted).toBeNull();
	});

	test("GET /ctl/stored/workspaces lists stored workspaces secret-free", async () => {
		const res = await get("/ctl/stored/workspaces");
		expect(res).not.toBeNull();
		expect(res!.status).toBe(200);
		const body = (await res!.json()) as StoredWorkspacesResponse;
		expect(body.workspaces.map((w) => w.workspaceId)).toEqual([WS_LIVE, WS_ORPHAN, WS_VERIFIED]);

		const live = body.workspaces[0]!;
		expect(live).toEqual({
			workspaceId: WS_LIVE,
			sessions: 5,
			bytes: bytesOf(ALPHA_MAIN, SUB_ONE, ADVISOR, NOTES, MANUAL, BETA_MAIN, PAGES_MAIN, NOTES),
			readOnly: false,
			orphaned: false,
			viewOnly: true,
			provenance: { projectId: "p-live", kind: "clone", profileId: "prof-1", sourceKind: "remote" },
		});

		// No live registry entry owns this workspace: orphaned, and the row's
		// only resume affordance is the link (nothing follows it here).
		const orphan = body.workspaces[1]!;
		expect(orphan).toEqual({
			workspaceId: WS_ORPHAN,
			sessions: 1,
			bytes: utf8(GAMMA_MAIN),
			readOnly: false,
			orphaned: true,
			viewOnly: true,
		});

		// Verified (read-only) workspace: the flip is threaded onto the row;
		// its provenance exposes the source KIND but never the source path.
		const verified = body.workspaces[2]!;
		expect(verified).toEqual({
			workspaceId: WS_VERIFIED,
			sessions: 1,
			bytes: utf8(EXTRA),
			readOnly: true,
			orphaned: false,
			viewOnly: true,
			provenance: {
				projectId: "p-verified",
				kind: "worktree",
				branch: "feat-1",
				pinnedRevision: "abc123",
				sourceKind: "local",
			},
		});
		expect(JSON.stringify(body)).not.toContain("/srv/secret-origin");
		expect(JSON.stringify(body)).not.toContain("example.invalid");
	});

	test("GET /ctl/stored/sessions enriches heads, counts kinds, and sorts by lastTs", async () => {
		const res = await get("/ctl/stored/sessions");
		expect(res!.status).toBe(200);
		const body = (await res!.json()) as StoredSessionsResponse;
		// Sessions without a readable head (no main, empty main, missing
		// main) have no lastTs and sort last by sessionId.
		expect(body.sessions.map((s) => s.sessionId)).toEqual([
			SESS_BETA,
			SESS_GAMMA,
			SESS_ALPHA,
			SESS_PAGES,
			SESS_EMPTY,
			SESS_NOMAIN,
			SESS_RO,
		]);

		const alpha = body.sessions.find((s) => s.sessionId === SESS_ALPHA)!;
		expect(alpha).toMatchObject({
			workspaceId: WS_LIVE,
			title: "Stored Title",
			cwd: "/srv/alpha",
			firstTs: 1000,
			lastTs: 2000,
			bytes: bytesOf(ALPHA_MAIN, SUB_ONE, ADVISOR, NOTES, MANUAL),
			fileCount: 5,
			kinds: { main: 1, subagent: 1, advisor: 1, metadata: 2 },
			mainRelpath: "sess-alpha.jsonl",
			readOnly: false,
			orphaned: false,
			missingAssets: 0,
			provenance: { projectId: "p-live", kind: "clone", profileId: "prof-1", sourceKind: "remote" },
		});

		// No title line: the header's own title/cwd are the fallback head.
		const beta = body.sessions.find((s) => s.sessionId === SESS_BETA)!;
		expect(beta).toMatchObject({
			title: "Beta Header",
			cwd: "/srv/beta",
			firstTs: 5000,
			lastTs: 5000,
		});

		// Metadata-only session: no main transcript, so no head enrichment.
		const nomain = body.sessions.find((s) => s.sessionId === SESS_NOMAIN)!;
		expect("mainRelpath" in nomain).toBe(false);
		expect(nomain).toMatchObject({
			title: null,
			cwd: null,
			firstTs: null,
			lastTs: null,
			kinds: { main: 0, subagent: 0, advisor: 0, metadata: 1 },
		});

		// Verified workspace rows carry the read-only flag; the missing main
		// is counted as a missing asset.
		const ro = body.sessions.find((s) => s.sessionId === SESS_RO)!;
		expect(ro).toMatchObject({
			readOnly: true,
			missingAssets: 1,
			mainRelpath: "sess-ro.jsonl",
			bytes: utf8(EXTRA),
		});
		expect(body.sessions.find((s) => s.sessionId === SESS_GAMMA)).toMatchObject({
			orphaned: true,
		});
	});

	test("GET /ctl/stored/sessions filters by workspaceId and tolerates unknown ones", async () => {
		const filtered = await get(`/ctl/stored/sessions?workspaceId=${WS_LIVE}`);
		expect(filtered!.status).toBe(200);
		const live = (await filtered!.json()) as StoredSessionsResponse;
		expect(live.sessions.map((s) => s.sessionId)).toEqual([
			SESS_BETA,
			SESS_ALPHA,
			SESS_PAGES,
			SESS_EMPTY,
			SESS_NOMAIN,
		]);
		expect(live.sessions.every((s) => s.workspaceId === WS_LIVE)).toBe(true);

		const unknown = await get("/ctl/stored/sessions?workspaceId=ws-unknown");
		expect(unknown!.status).toBe(200);
		expect(await unknown!.json()).toEqual({ sessions: [] });
	});

	test("GET /ctl/stored/sessions/:workspaceId/:sessionId returns ordered file rows", async () => {
		const res = await get(`/ctl/stored/sessions/${WS_LIVE}/${SESS_ALPHA}`);
		expect(res!.status).toBe(200);
		const detail = (await res!.json()) as StoredSessionDetail;
		// Ordering: main, then the artifact subtree (depth then name), then
		// metadata; the depth-1 notes.txt precedes the nested manual note.
		expect(detail.files.map((f) => [f.relpath, f.kind, f.status])).toEqual([
			["sess-alpha.jsonl", "main", "stored"],
			["sess-alpha/sub-one.jsonl", "subagent", "stored"],
			["sess-alpha/__advisor.jsonl", "advisor", "stored"],
			["notes.txt", "metadata", "stored"],
			["sess-alpha/manual-note.txt", "metadata", "stored"],
		]);
		expect(detail.files[0]).toMatchObject({
			bytes: utf8(ALPHA_MAIN),
			ackedBytes: utf8(ALPHA_MAIN),
			eof: true,
		});
		expect(detail.files[1]).toMatchObject({
			parentPath: "sess-alpha.jsonl",
			bytes: utf8(SUB_ONE),
			eof: false,
		});
		// Unindexed on disk (listed, never adopted): no ack state to report.
		expect(detail.files[4]).toMatchObject({
			parentPath: "sess-alpha.jsonl",
			bytes: utf8(MANUAL),
			ackedBytes: 0,
			eof: false,
		});

		// Indexed-but-absent file: visible as missing, never a broken link.
		const roRes = await get(`/ctl/stored/sessions/${WS_VERIFIED}/${SESS_RO}`);
		const ro = (await roRes!.json()) as StoredSessionDetail;
		expect(ro.files[0]).toEqual({
			relpath: "sess-ro.jsonl",
			kind: "main",
			bytes: 0,
			ackedBytes: 0,
			eof: true,
			status: "missing",
		});
	});

	test("unknown sessions answer the unavailable envelope", async () => {
		const res = await get(`/ctl/stored/sessions/${WS_LIVE}/sess-absent`);
		expect(res!.status).toBe(404);
		expect(await res!.json()).toEqual({
			error: { code: "unavailable", message: "session not found in fleet store" },
		});
	});
});

describe("stored provenance projection", () => {
	test("omits absent optionals and never serializes source paths/URLs", () => {
		// The only provenance a client ever sees: project identity, kind, and
		// the optional profile/branch/pin plus the source KIND, never the
		// source path or URL itself.
		expect(toPublicProvenance({ projectId: "p", kind: "direct" })).toEqual({
			projectId: "p",
			kind: "direct",
		});
		expect(
			toPublicProvenance({ projectId: "p", kind: "clone", source: { local: "/srv/origin" } }),
		).toEqual({ projectId: "p", kind: "clone", sourceKind: "local" });
		expect(
			toPublicProvenance({
				projectId: "p",
				kind: "worktree",
				profileId: "prof-1",
				branch: "feat-1",
				pinnedRevision: "abc123",
				source: { remote: "https://example.invalid/repo.git" },
			}),
		).toEqual({
			projectId: "p",
			kind: "worktree",
			profileId: "prof-1",
			branch: "feat-1",
			pinnedRevision: "abc123",
			sourceKind: "remote",
		});
	});
});

describe("stored reserved-name and unsafe-component guards", () => {
	test("store-reserved names are refused as workspace/session ids", async () => {
		for (const reserved of ["index.json", "readonly.json"]) {
			const asWorkspace = await get(`/ctl/stored/sessions?workspaceId=${reserved}`);
			expect(asWorkspace!.status).toBe(400);
			expect(await asWorkspace!.json()).toEqual({
				error: { code: "invalid_request", message: "invalid workspaceId" },
			});

			const asSession = await get(`/ctl/stored/sessions/${WS_LIVE}/${reserved}`);
			expect(asSession!.status).toBe(400);
			expect(await asSession!.json()).toEqual({
				error: { code: "invalid_request", message: "invalid session identity" },
			});

			const asWorkspacePath = await get(
				`/ctl/stored/sessions/${reserved}/${SESS_ALPHA}/transcript`,
			);
			expect(asWorkspacePath!.status).toBe(400);
		}
	});

	test("unsafe workspaceId values are refused with invalid_request", async () => {
		// Encoded traversal, a NUL, invalid percent-encoding, an empty value,
		// a POSIX separator, a backslash, and the bare dot components all fail
		// the single-component rules.
		for (const value of ["..%2Fetc", "a%00b", "%zz", "", "a%5Cb", ".", ".."]) {
			const res = await get(`/ctl/stored/sessions?workspaceId=${value}`);
			expect(res!.status).toBe(400);
			expect(await res!.json()).toEqual({
				error: { code: "invalid_request", message: "invalid workspaceId" },
			});
		}

		const traversal = await get(`/ctl/stored/sessions/..%2Fetc/${SESS_ALPHA}`);
		expect(traversal!.status).toBe(400);
		expect(await traversal!.json()).toEqual({
			error: { code: "invalid_request", message: "invalid session identity" },
		});

		// Undecodable path segments are 400s on both identity routes.
		for (const path of [
			`/ctl/stored/sessions/%zz/${SESS_ALPHA}`,
			`/ctl/stored/sessions/%zz/${SESS_ALPHA}/transcript`,
			`/ctl/stored/sessions/${WS_LIVE}/%zz`,
			`/ctl/stored/sessions/${WS_LIVE}/%zz/transcript`,
		]) {
			const res = await get(path);
			expect(res!.status).toBe(400);
			expect(await res!.json()).toEqual({
				error: { code: "invalid_request", message: "invalid session identity" },
			});
		}
	});

	test("unsafe file relpaths are refused; readonly.json is not a relpath-reserved name", async () => {
		const transcript = `/ctl/stored/sessions/${WS_LIVE}/${SESS_ALPHA}/transcript`;
		// index.json and the store tmp suffix are reserved; traversal,
		// absolute paths, backslashes, NULs and unnormalized paths are unsafe.
		for (const file of [
			"index.json",
			"sess-alpha.jsonl.tmp",
			"%2Fetc%2Fpasswd",
			"..%2Fescape.jsonl",
			"a%2F%2Fb.jsonl",
			"a%2F.%2Fb.jsonl",
			"a%5Cb.jsonl",
			"a%00b.jsonl",
			"%zz",
			"",
		]) {
			const res = await get(`${transcript}?file=${file}`);
			expect(res!.status).toBe(400);
			expect(await res!.json()).toEqual({
				error: { code: "invalid_request", message: "invalid file relpath" },
			});
		}

		// readonly.json is reserved as an ID component, not as a relpath: as a
		// file query it is an ordinary (absent) name inside the session dir.
		const res = await get(`${transcript}?file=readonly.json`);
		expect(res!.status).toBe(404);
		expect(await res!.json()).toEqual({
			error: {
				code: "unavailable",
				message: "stored file readonly.json is unavailable (missing on disk)",
			},
		});
	});
});

describe("stored transcript route (parsed)", () => {
	test("answers the same TranscriptPage shape as /ctl/stats", async () => {
		const res = await get(`/ctl/stored/sessions/${WS_LIVE}/${SESS_ALPHA}/transcript`);
		expect(res!.status).toBe(200);
		expect(res!.headers.get("content-type")).toContain("application/json");
		const page = (await res!.json()) as TranscriptPage;
		expect(page.entries).toEqual([
			{ type: "title", title: "Stored Title" },
			{ type: "session", id: SESS_ALPHA, cwd: "/srv/alpha", title: "Alpha Header" },
			{ type: "message", id: "a1", timestamp: 1000 },
			{ type: "message", id: "a2", timestamp: 2000 },
		]);
		expect(page).toMatchObject({
			offset: 0,
			limit: 200,
			totalLines: 4,
			nextOffset: null,
			truncated: false,
		});
	});

	test("caps limit, pages by offset, and reports the page ending at EOF", async () => {
		const transcript = `/ctl/stored/sessions/${WS_LIVE}/${SESS_PAGES}/transcript`;

		const first = (await (await get(transcript))!.json()) as TranscriptPage;
		expect(first.entries).toHaveLength(200);
		expect(first).toMatchObject({
			offset: 0,
			limit: 200,
			totalLines: PAGES_LINES,
			nextOffset: 200,
		});
		expect(first.entries[0]).toEqual({ type: "session", id: SESS_PAGES, cwd: "/srv/pages" });

		// A limit beyond the cap is clamped to 500, never honored.
		const clamped = (await (await get(`${transcript}?limit=9999`))!.json()) as TranscriptPage;
		expect(clamped).toMatchObject({ offset: 0, limit: 500, nextOffset: 500 });
		expect(clamped.entries).toHaveLength(500);

		// The last page ends exactly at EOF: no nextOffset, no short page.
		const last = (await (await get(
			`${transcript}?offset=500&limit=200`,
		))!.json()) as TranscriptPage;
		expect(last.entries).toHaveLength(PAGES_LINES - 500);
		expect(last).toMatchObject({
			offset: 500,
			limit: 200,
			totalLines: PAGES_LINES,
			nextOffset: null,
		});

		const tail = (await (await get(
			`${transcript}?offset=600&limit=200`,
		))!.json()) as TranscriptPage;
		expect(tail.entries).toHaveLength(1);
		expect(tail.nextOffset).toBeNull();

		// At and past the end: an empty final page, still offset-accurate.
		const atEnd = (await (await get(
			`${transcript}?offset=${PAGES_LINES}`,
		))!.json()) as TranscriptPage;
		expect(atEnd.entries).toEqual([]);
		expect(atEnd).toMatchObject({ offset: PAGES_LINES, totalLines: PAGES_LINES, nextOffset: null });
		const past = (await (await get(
			`${transcript}?offset=999999&limit=10`,
		))!.json()) as TranscriptPage;
		expect(past.entries).toEqual([]);
		expect(past.nextOffset).toBeNull();
	});

	test("malformed or out-of-range offset/limit coerce to the documented defaults", async () => {
		// The route validates ONLY identity/relpath/format: offset and limit
		// are parseInt-coerced (non-numeric or negative offset → 0, limit ≤ 0
		// or non-numeric → 200), never an error.
		const transcript = `/ctl/stored/sessions/${WS_LIVE}/${SESS_PAGES}/transcript`;
		for (const query of ["offset=abc&limit=xyz", "offset=-5&limit=0", "limit=-1"]) {
			const res = await get(`${transcript}?${query}`);
			expect(res!.status).toBe(200);
			const page = (await res!.json()) as TranscriptPage;
			expect(page).toMatchObject({ offset: 0, limit: 200 });
			expect(page.entries).toHaveLength(200);
		}
	});

	test("a final line without a newline still counts; corrupt lines are skipped", async () => {
		const res = await get(
			`/ctl/stored/sessions/${WS_LIVE}/${SESS_ALPHA}/transcript?file=${enc("sess-alpha/sub-one.jsonl")}`,
		);
		expect(res!.status).toBe(200);
		const page = (await res!.json()) as TranscriptPage;
		expect(page.entries).toEqual([{ type: "message", id: "s1", timestamp: 1500 }]);
		expect(page).toMatchObject({ totalLines: 2, nextOffset: null, truncated: false });
	});

	test("sessions without a main transcript answer the unavailable envelope", async () => {
		const noMain = await get(`/ctl/stored/sessions/${WS_LIVE}/${SESS_NOMAIN}/transcript`);
		expect(noMain!.status).toBe(404);
		expect(await noMain!.json()).toEqual({
			error: { code: "unavailable", message: "no main transcript stored for this session" },
		});

		const goneFile = await get(`/ctl/stored/sessions/${WS_VERIFIED}/${SESS_RO}/transcript`);
		expect(goneFile!.status).toBe(404);
		expect(await goneFile!.json()).toEqual({
			error: {
				code: "unavailable",
				message: "stored file sess-ro.jsonl is unavailable (missing on disk)",
			},
		});

		const unknown = await get(`/ctl/stored/sessions/${WS_LIVE}/sess-absent/transcript`);
		expect(unknown!.status).toBe(404);
		expect(await unknown!.json()).toEqual({
			error: { code: "unavailable", message: "session not found in fleet store" },
		});
	});
});

describe("stored transcript route (raw)", () => {
	test("streams the exact stored bytes, including a file without a trailing newline", async () => {
		const res = await get(`/ctl/stored/sessions/${WS_LIVE}/${SESS_ALPHA}/transcript?format=raw`);
		expect(res!.status).toBe(200);
		expect(res!.headers.get("content-type")).toBe("application/x-ndjson; charset=utf-8");
		expect(await res!.text()).toBe(ALPHA_MAIN);

		// format is case-insensitive, and a subagent file is readable by relpath.
		const sub = await get(
			`/ctl/stored/sessions/${WS_LIVE}/${SESS_ALPHA}/transcript?format=RAW&file=${enc("sess-alpha/sub-one.jsonl")}`,
		);
		expect(sub!.status).toBe(200);
		expect(await sub!.text()).toBe(SUB_ONE);
	});

	test("unknown formats and missing files are typed refusals", async () => {
		const transcript = `/ctl/stored/sessions/${WS_LIVE}/${SESS_ALPHA}/transcript`;
		const badFormat = await get(`${transcript}?format=xml`);
		expect(badFormat!.status).toBe(400);
		expect(await badFormat!.json()).toEqual({
			error: { code: "invalid_request", message: "invalid format (parsed|raw)" },
		});

		for (const format of ["raw", "parsed"]) {
			const missing = await get(`${transcript}?format=${format}&file=absent.jsonl`);
			expect(missing!.status).toBe(404);
			expect(await missing!.json()).toEqual({
				error: {
					code: "unavailable",
					message: "stored file absent.jsonl is unavailable (missing on disk)",
				},
			});
		}
	});
});

describe("FleetLogStore.readStoredPrefix", () => {
	test("reads at most maxBytes from the start, cutting mid-line when capped", () => {
		const cap = 16;
		const prefix = store.readStoredPrefix(WS_LIVE, SESS_PAGES, "sess-pages.jsonl", cap);
		expect(prefix).not.toBeNull();
		if (prefix === null) throw new Error("unreachable");
		expect(prefix.length).toBe(cap);
		expect(prefix.equals(Buffer.from(PAGES_MAIN.slice(0, cap), "utf8"))).toBe(true);
		// The cap is byte-honest, not line-honest: the caller (the transcript
		// route) reports `truncated` from this cut, never a wrong total.
		expect(PAGES_MAIN.length).toBeGreaterThan(cap);
		expect(prefix.toString("utf8").endsWith("\n")).toBe(false);
	});

	test("a cap at or above the file size returns the whole file; zero returns null", () => {
		const size = utf8(ALPHA_MAIN);
		const exact = store.readStoredPrefix(WS_LIVE, SESS_ALPHA, "sess-alpha.jsonl", size);
		const over = store.readStoredPrefix(WS_LIVE, SESS_ALPHA, "sess-alpha.jsonl", size + 4096);
		expect(exact?.equals(Buffer.from(ALPHA_MAIN, "utf8"))).toBe(true);
		expect(over?.equals(Buffer.from(ALPHA_MAIN, "utf8"))).toBe(true);
		expect(store.readStoredPrefix(WS_LIVE, SESS_ALPHA, "sess-alpha.jsonl", 0)).toBeNull();
	});

	test("missing files and unsafe ids/relpaths return null, never throw", () => {
		expect(store.readStoredPrefix(WS_VERIFIED, SESS_RO, "sess-ro.jsonl", 64)).toBeNull();
		expect(store.readStoredPrefix(WS_LIVE, "sess-absent", "sess-absent.jsonl", 64)).toBeNull();
		expect(store.readStoredPrefix(WS_LIVE, SESS_ALPHA, "index.json", 64)).toBeNull();
		expect(store.readStoredPrefix(WS_LIVE, SESS_ALPHA, "../escape.jsonl", 64)).toBeNull();
		expect(store.readStoredPrefix("..", SESS_ALPHA, "sess-alpha.jsonl", 64)).toBeNull();
	});
});

describe("stored-history reads never wake compute", () => {
	const STORED_ONLY = "ws-stored-only";
	const SESS_1 = "sess-1";
	const STORED_BODY =
		line({ type: "session", id: SESS_1, cwd: "/srv/stored" }) +
		line({ type: "message", id: "m1", timestamp: 1 });

	test("browsing sessions and transcripts spawns nothing, respawns nothing, and enrolls no daemon", async () => {
		const paths = fleetPaths("omp-stored-wake-");
		// Seed a stored-only workspace: history on disk, no registry entry and
		// no daemon (the store lives at dirname(statePath)/logs, exactly where
		// the booting fleet loads it from).
		const seeder = new FleetLogStore({ rootDir: join(paths.tmp, "logs") });
		const seeded = seeder.ingest(
			STORED_ONLY,
			SESS_1,
			"sess-1.jsonl",
			chunkAt(0, STORED_BODY, true),
		);
		expect(seeded.status).toBe("acked");

		const server: FleetServer = await startTestFleet(paths, {});
		try {
			// The observables (the real-server analogue of fanout.test.ts's
			// `respawned` recorder): spawnHost/start are the ONLY
			// fleet paths that create a daemon, and a daemon is the only thing
			// that can dial in (daemons dial OUT; the fleet never dials, and
			// sendToDaemon is the only fleet→daemon push). A stored-only
			// workspace can therefore acquire a live daemon, a resume, or a
			// pair ONLY through these three; all stay empty below while every
			// route answers real stored data, which proves browsing woke
			// nothing. The wrappers throw so a wrong wake fails loudly instead
			// of launching a child.
			const spawned: string[] = [];
			const respawned: string[] = [];
			const pushed: string[] = [];
			server.lifecycle.spawnHost = async (init) => {
				spawned.push(init.cwd);
				throw new Error("stored browsing must not spawn");
			};
			server.lifecycle.start = async (daemonId) => {
				respawned.push(daemonId);
				throw new Error("stored browsing must not respawn");
			};
			server.transport.sendToDaemon = async (workspaceId) => {
				pushed.push(workspaceId);
				throw new Error("stored browsing must not touch a daemon");
			};

			const base = `http://127.0.0.1:${server.port}/ctl/stored`;
			const workspaces = await fetch(`${base}/workspaces`);
			expect(workspaces.status).toBe(200);
			const wsBody = (await workspaces.json()) as StoredWorkspacesResponse;
			expect(wsBody.workspaces).toHaveLength(1);
			// Orphaned: the row is flagged; no resume affordance is offered.
			expect(wsBody.workspaces[0]).toMatchObject({
				workspaceId: STORED_ONLY,
				orphaned: true,
			});

			const sessions = await fetch(`${base}/sessions?workspaceId=${STORED_ONLY}`);
			expect(sessions.status).toBe(200);
			expect(((await sessions.json()) as StoredSessionsResponse).sessions).toHaveLength(1);

			const detail = await fetch(`${base}/sessions/${STORED_ONLY}/${SESS_1}`);
			expect(detail.status).toBe(200);
			expect(((await detail.json()) as StoredSessionDetail).files).toHaveLength(1);

			const parsed = await fetch(`${base}/sessions/${STORED_ONLY}/${SESS_1}/transcript`);
			expect(parsed.status).toBe(200);
			expect(((await parsed.json()) as TranscriptPage).entries).toHaveLength(2);

			const raw = await fetch(`${base}/sessions/${STORED_ONLY}/${SESS_1}/transcript?format=raw`);
			expect(raw.status).toBe(200);
			expect(await raw.text()).toBe(STORED_BODY);

			expect(spawned).toEqual([]);
			expect(respawned).toEqual([]);
			expect(pushed).toEqual([]);
			expect(server.lifecycle.hostSnapshot()).toEqual({});
			expect(server.transport.enrolledWorkspaceIds()).toEqual([]);
			expect(server.transport.pairStatus(STORED_ONLY).enrolled).toBe(false);
			expect(server.registry.list()).toEqual([]);
		} finally {
			await server.close();
		}
	});
});

describe("stored transcript windowed paging", () => {
	const WS = "ws-window";
	const SESS = "sess-window";
	const SESS_BIG = "sess-big";
	const TOTAL = 2600;
	const CORRUPT = "corrupt-not-json";
	const CORRUPT_AT = 1500;
	/** Raw lines of the fixture (one corrupt); the final line has no trailing newline. */
	const rawLines = Array.from({ length: TOTAL }, (_, i) =>
		i === CORRUPT_AT ? CORRUPT : JSON.stringify({ type: "message", id: `w${i}`, timestamp: i }),
	);
	/** What a full parse yields for raw lines [from, from + count): corrupt lines are skipped. */
	const expectedEntries = (from: number, count: number): unknown[] =>
		rawLines
			.slice(from, from + count)
			.filter((text) => text !== CORRUPT)
			.map((text) => JSON.parse(text));
	/** Five 1.2 MB lines: a page must stop after four, under the 4 MiB budget. */
	const bigLines = Array.from({ length: 5 }, (_, i) =>
		JSON.stringify({ type: "message", id: `big${i}`, pad: "x".repeat(1_200_000) }),
	);

	type TranscriptPage = {
		offset: number;
		totalLines: number;
		nextOffset: number | null;
		truncated: boolean;
		entries: unknown[];
	};

	let windowApp: StoredApp;
	beforeAll(() => {
		const seeded = new FleetLogStore({ rootDir: tempDir("omp-stored-window-") });
		const main = seeded.ingest(WS, SESS, `${SESS}.jsonl`, chunkAt(0, rawLines.join("\n"), true));
		expect(main.status).toBe("acked");
		const big = seeded.ingest(
			WS,
			SESS_BIG,
			`${SESS_BIG}.jsonl`,
			chunkAt(0, `${bigLines.join("\n")}\n`, true),
		);
		expect(big.status).toBe("acked");
		windowApp = createStoredApp({
			store: seeded,
			provenance: (workspaceId) => PROVENANCE[workspaceId],
		});
	});

	const pageAt = async (session: string, query: string): Promise<TranscriptPage> => {
		const path = `/ctl/stored/sessions/${WS}/${session}/transcript?${query}`;
		const res = await windowApp.handleFetch(
			new Request(`http://localhost${path}`),
			new URL(`http://localhost${path}`),
		);
		expect(res!.status).toBe(200);
		return (await res!.json()) as TranscriptPage;
	};

	test("paging by offset returns the same entries as a full parse", async () => {
		const walked: unknown[] = [];
		let offset: number | null = 0;
		while (offset !== null) {
			const page = await pageAt(SESS, `offset=${offset}&limit=500`);
			expect(page).toMatchObject({ offset, totalLines: TOTAL });
			expect(page.entries).toEqual(expectedEntries(offset, 500));
			walked.push(...page.entries);
			offset = page.nextOffset;
		}
		expect(walked).toEqual(expectedEntries(0, TOTAL));
	});

	test("windows straddling index checkpoints and corrupt lines match the full parse", async () => {
		const windows = [
			{ from: 999, count: 3 },
			{ from: 1000, count: 1 },
			{ from: 1499, count: 3 },
			{ from: 1998, count: 5 },
			{ from: 2599, count: 4 },
		];
		for (const { from, count } of windows) {
			const page = await pageAt(SESS, `offset=${from}&limit=${count}`);
			expect(page.entries).toEqual(expectedEntries(from, count));
			expect(page.nextOffset).toBe(from + count < TOTAL ? from + count : null);
		}
		const past = await pageAt(SESS, `offset=${TOTAL}&limit=10`);
		expect(past).toMatchObject({ entries: [], nextOffset: null, totalLines: TOTAL });
	});

	test("a page stops at the byte budget and the next page resumes from nextOffset", async () => {
		const parsed = bigLines.map((text) => JSON.parse(text));
		const first = await pageAt(SESS_BIG, "offset=0&limit=500");
		expect(first).toMatchObject({ offset: 0, totalLines: 5, nextOffset: 4, truncated: true });
		expect(first.entries).toEqual(parsed.slice(0, 4));
		const rest = await pageAt(SESS_BIG, "offset=4&limit=500");
		expect(rest).toMatchObject({ offset: 4, totalLines: 5, nextOffset: null, truncated: false });
		expect(rest.entries).toEqual(parsed.slice(4));
	});
});

describe("stored head reads stay bounded", () => {
	test("readStoredHead parses only the head but reports the full stored size", () => {
		const body = Array.from({ length: 3000 }, (_, i) =>
			line({ type: "message", id: `m${i}`, timestamp: i }),
		).join("");
		const content = line({ type: "session", id: "sess-head", cwd: "/srv/head" }) + body;
		expect(utf8(content)).toBeGreaterThan(SESSION_HEAD_BYTES);
		const seeded = new FleetLogStore({ rootDir: tempDir("omp-stored-head-") });
		const result = seeded.ingest(
			WS_LIVE,
			"sess-head",
			"sess-head.jsonl",
			chunkAt(0, content, true),
		);
		expect(result.status).toBe("acked");
		expect(readStoredHead(seeded, WS_LIVE, "sess-head", "sess-head.jsonl")).toMatchObject({
			id: "sess-head",
			cwd: "/srv/head",
			bytes: utf8(content),
		});
		expect(readStoredHead(seeded, WS_LIVE, "sess-absent", "sess-absent.jsonl")).toBeNull();
	});
});
