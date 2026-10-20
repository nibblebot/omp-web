import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { fetchCloneIntoProject, setState, state } from "../../state";
import { installLocalStorageShim, restoreBrowserGlobals, setBrowserGlobal } from "../web.testkit";

type RecordedFetch = { url: string; method: string; body: unknown };

/** Swap globalThis.fetch for a JSON responder; records every request. */
function stubFetch(status: number, body: unknown): RecordedFetch[] {
	const requests: RecordedFetch[] = [];
	setBrowserGlobal("fetch", (async (input: unknown, init?: RequestInit) => {
		requests.push({
			url: String(input),
			method: init?.method ?? "GET",
			body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
		});
		return {
			ok: status >= 200 && status < 300,
			status,
			json: async () => body,
			text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
		} as unknown as Response;
	}) as unknown as typeof fetch);
	return requests;
}

beforeEach(() => {
	installLocalStorageShim();
	// Toasts schedule their auto-dismiss on window.setTimeout; keep it inert.
	setBrowserGlobal("window", { setTimeout: () => 0 } as unknown as Window & typeof globalThis);
	setState({ toasts: [], authStatus: "disabled" });
});

afterEach(() => {
	restoreBrowserGlobals();
	setState({ toasts: [] });
});

describe("fetchCloneIntoProject", () => {
	test("POSTs the clone's fetch route and toasts what landed", async () => {
		const requests = stubFetch(200, {
			daemonId: "d7",
			branch: "feat-x",
			projectPath: "/repo",
			outcome: "updated",
			commit: "abc",
		});

		expect(await fetchCloneIntoProject("d7")).toBe(true);

		expect(requests).toEqual([
			{ url: "/ctl/clones/d7/fetch-into-project", method: "POST", body: {} },
		]);
		expect(state.toasts.map((t) => t.text)).toEqual(["Fast-forwarded feat-x into /repo"]);
	});

	test("shows the fleet's refusal reason and reports failure", async () => {
		stubFetch(409, { error: "branch feat-x is checked out at /repo" });

		expect(await fetchCloneIntoProject("d7")).toBe(false);

		expect(state.toasts.map((t) => t.text)).toEqual([
			"Fetch into project refused: branch feat-x is checked out at /repo",
		]);
	});
});
