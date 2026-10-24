/**
 * The jobs sheet's daemon methods against a real AgentSession and its real
 * AsyncJobManager: the tree the SDK builds, the inspection a row opens, and the
 * cancel that only reaches the session's own jobs.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createAgentSession, Settings } from "@oh-my-pi/pi-coding-agent";
import type { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { JobWidgets } from "@oh-my-pi/pi-coding-agent/job-widgets/registry";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { cleanupTempDirs, tempDir } from "#lib/testkit/temp-dir.testkit";
import type {
	JobCancelResultDto,
	JobDetailDto,
	JobDto,
	JobTreeDto,
	JobTreeRowDto,
} from "#lib/wire/protocol";
import { createJobMethods, JOB_OUTPUT_TAIL_CHARS } from "../job-methods";
import type { SessionEntry } from "../session-entry";

afterAll(cleanupTempDirs);

type RegisterOptions = NonNullable<Parameters<AsyncJobManager["register"]>[3]>;

let session: AgentSession;
let jobs: AsyncJobManager;
let entry: SessionEntry;
const methods = createJobMethods();

beforeEach(async () => {
	const cwd = tempDir("omp-jobs-");
	const result = await createAgentSession({
		cwd,
		settings: Settings.isolated(),
		sessionManager: SessionManager.inMemory(cwd),
		agentRegistry: new AgentRegistry(),
		disableExtensionDiscovery: true,
		enableLsp: false,
	});
	session = result.session;
	jobs = session.asyncJobManager!;
	entry = { session } as unknown as SessionEntry;
});

afterEach(async () => {
	await session.dispose();
});

/** A job that runs until it is released or cancelled; `output` is what it has reported so far. */
function hold(
	type: "bash" | "task",
	label: string,
	options: RegisterOptions = {},
	output?: string,
) {
	const release = Promise.withResolvers<string>();
	const id = jobs.register(
		type,
		label,
		({ signal, reportProgress }) => {
			if (output !== undefined) void reportProgress(output);
			signal.addEventListener("abort", () => release.resolve("aborted"));
			return release.promise;
		},
		{ ownerId: "Main", ...options },
	);
	const settled = () => jobs.getJob(id)!.promise;
	return {
		id,
		settled,
		finish: async (text = "done") => {
			release.resolve(text);
			await settled();
		},
	};
}

const tree = async () => (await methods.getJobTree(entry, [])) as JobTreeDto;
const jobRow = (rows: JobTreeRowDto[], id: string): JobDto | undefined => {
	const row = rows.find((r) => r.kind === "job" && r.job.id === id);
	return row?.kind === "job" ? row.job : undefined;
};
const labels = (rows: JobTreeRowDto[]) =>
	rows.map((row) => (row.kind === "job" ? row.job.label : `agent:${row.agent.id}`));
const detail = async (id: string) =>
	(await methods.getJobDetail(entry, [id])) as JobDetailDto | null;
const cancel = (id: string) => methods.cancelJob(entry, [id]) as Promise<JobCancelResultDto>;

describe("getJobTree", () => {
	test("nests a subagent's jobs under its task job, busiest branch first, and marks only the session's own jobs", async () => {
		const leaf = hold("bash", "tail -f log");
		const task = hold("task", "explore the repo", { agentId: "Explorer" });
		const child = hold("bash", "npm test", { ownerId: "Explorer" });
		const { rootId, rows } = await tree();
		expect(rootId).toBe("Main");
		expect(labels(rows)).toEqual(["explore the repo", "npm test", "tail -f log"]);
		expect(rows.map((row) => [row.depth, row.parent, row.last])).toEqual([
			[0, true, false],
			[1, false, true],
			[0, false, true],
		]);
		expect([task.id, child.id, leaf.id].map((id) => jobRow(rows, id)?.own)).toEqual([
			true,
			false,
			true,
		]);
		const head = rows[0]!;
		expect(head.kind === "job" && head.agent?.id).toBe("Explorer");
		for (const job of [leaf, task, child]) await job.finish();
	});

	test("lists a settled job with its end time", async () => {
		const job = hold("bash", "make build");
		await job.finish("built");
		const row = jobRow((await tree()).rows, job.id);
		expect(row).toMatchObject({ status: "completed", label: "make build", own: true });
		expect(row?.endTime).toBeGreaterThanOrEqual(row!.startTime);
	});

	test("leaves jobs owned outside the session's tree out", async () => {
		const stranger = hold("bash", "someone else's", { ownerId: "Stranger" });
		expect((await tree()).rows).toEqual([]);
		await stranger.finish();
	});

	test("keeps the full command line out of the rows", async () => {
		const job = hold("bash", "echo hi", {
			process: { command: "echo hi && sleep 1", cwd: "/work", pids: () => [] },
		});
		expect(jobRow((await tree()).rows, job.id)).not.toHaveProperty("command");
		await job.finish();
	});

	test("honors a recent limit", async () => {
		for (let i = 0; i < 3; i++) await hold("bash", `quick-${i}`).finish();
		const limited = (await methods.getJobTree(entry, [{ recentLimit: 1 }])) as JobTreeDto;
		expect(limited.rows).toHaveLength(1);
	});
});

describe("getJobDetail", () => {
	test("answers the command, directory, pids and live output of a running job", async () => {
		const job = hold(
			"bash",
			"sleep 60",
			{ process: { command: "sleep 60 && echo done", cwd: "/work", pids: () => [4242] } },
			"waiting\n",
		);
		expect(await detail(job.id)).toEqual({
			command: "sleep 60 && echo done",
			cwd: "/work",
			pids: [4242],
			output: "waiting\n",
		});
		await job.finish();
	});

	test("answers the exit status and final output of a settled command", async () => {
		const job = hold("bash", "make", {
			process: { command: "make", cwd: "/work", pids: () => [4242] },
		});
		await job.finish("built");
		expect(await detail(job.id)).toEqual({
			command: "make",
			cwd: "/work",
			pids: [],
			exitCode: 0,
			output: "built",
		});
	});

	test("cuts a long output to its tail and says so", async () => {
		const output = `${"x".repeat(JOB_OUTPUT_TAIL_CHARS)}tail`;
		const job = hold("bash", "chatty", {}, output);
		const answer = await detail(job.id);
		expect(answer?.output).toBe(output.slice(-JOB_OUTPUT_TAIL_CHARS));
		expect(answer?.output?.endsWith("tail")).toBe(true);
		expect(answer?.outputTruncated).toBe(true);
		await job.finish();
	});

	test("answers null for an unknown job and for one owned outside the tree", async () => {
		const stranger = hold("bash", "someone else's", { ownerId: "Stranger" });
		expect(await detail("nope")).toBeNull();
		expect(await detail(stranger.id)).toBeNull();
		await stranger.finish();
	});
});

describe("cancelJob", () => {
	test("stops a running job the session owns", async () => {
		const job = hold("bash", "watch");
		expect(await cancel(job.id)).toEqual({ cancelled: true });
		await job.settled();
		expect(jobRow((await tree()).rows, job.id)?.status).toBe("cancelled");
	});

	test("refuses a subagent's job and leaves it running", async () => {
		const task = hold("task", "explore", { agentId: "Explorer" });
		const child = hold("bash", "npm test", { ownerId: "Explorer" });
		await expect(cancel(child.id)).rejects.toMatchObject({ code: "not_eligible" });
		expect(jobRow((await tree()).rows, child.id)?.status).toBe("running");
		await task.finish();
		await child.finish();
	});

	test("refuses a job outside the session's tree and an unknown id", async () => {
		const stranger = hold("bash", "someone else's", { ownerId: "Stranger" });
		await expect(cancel(stranger.id)).rejects.toMatchObject({ code: "not_eligible" });
		await expect(cancel("nope")).rejects.toMatchObject({ code: "not_eligible" });
		expect(jobs.getJob(stranger.id)?.status).toBe("running");
		await stranger.finish();
	});

	test("reports false for a job that already settled", async () => {
		const job = hold("bash", "quick");
		await job.finish();
		expect(await cancel(job.id)).toEqual({ cancelled: false });
	});

	test("needs a job id", async () => {
		await expect(methods.cancelJob(entry, [])).rejects.toThrow("job id required");
	});
});

describe("job widgets", () => {
	let enabled = true;
	beforeEach(() => {
		enabled = true;
		// Without an author the registry derives the model-free view from the job's output: lines and the last line.
		jobs.widgets = new JobWidgets({ enabled: () => enabled });
	});

	/** A job whose output a widget can read. */
	const watched = (label: string, text: string, options: RegisterOptions = {}) =>
		hold("bash", label, {
			widgetInputs: {
				sources: () => [
					{
						id: "out",
						label: "output",
						read: (from) => ({ start: 0, end: text.length, text: text.slice(from), open: true }),
					},
				],
				brief: () => ({ kind: "bash" }),
			},
			...options,
		});
	const rowWidget = async (id: string) => {
		const row = (await tree()).rows.find((r) => r.kind === "job" && r.job.id === id);
		return row?.kind === "job" ? row.widget : undefined;
	};

	test("a running job's row carries its widget cut to a glance, and its detail the whole view", async () => {
		const job = watched("serve", "one\ntwo\nthree\n");
		const glance = await rowWidget(job.id);
		expect(glance).toMatchObject({ title: "serve", stage: "three", state: "fallback" });
		expect(glance?.blocks).toEqual([]);
		const whole = (await detail(job.id))?.widget;
		expect(whole).toMatchObject({ title: "serve", stage: "three", state: "fallback" });
		expect(whole?.blocks[0]).toMatchObject({
			kind: "stat",
			items: [{ label: "lines", text: "3" }, {}],
		});
		await job.finish();
	});

	test("a settled job's row carries none, its detail its last view", async () => {
		const job = watched("build", "compiling\ndone\n");
		await job.finish();
		expect(await rowWidget(job.id)).toBeUndefined();
		expect((await detail(job.id))?.widget).toMatchObject({ title: "build", stage: "done" });
	});

	test("neither carries a widget while async.widgets is off, nor for a job with nothing to watch", async () => {
		const job = watched("serve", "one\n");
		const plain = hold("bash", "sleep 60");
		expect(await rowWidget(plain.id)).toBeUndefined();
		expect((await detail(plain.id))?.widget).toBeUndefined();
		enabled = false;
		expect(await rowWidget(job.id)).toBeUndefined();
		expect(await detail(job.id)).not.toHaveProperty("widget");
		enabled = true;
		expect(await rowWidget(job.id)).toBeDefined();
		await job.finish();
		await plain.finish();
	});
});
