/**
 * What a daemon row does over the wire: restart and kill answer through the broker and replace the
 * roster entry (one command at a time), and an expanded row's log tail loads, refreshes, and
 * survives a failed refresh.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createRoot } from "solid-js";
import { daemonsKey, type DaemonInfo } from "#lib/wire/protocol";
import { createDaemonControl, createDaemonLogs } from "../../activities/daemons";
import { connect, setState, state } from "../../state";
import {
	FakeWebSocket,
	dispatch,
	flushMicrotasks,
	installTransportStubs,
	posted,
	restoreBrowserGlobals,
} from "../web.testkit";

const vite: DaemonInfo = {
	name: "vite",
	id: "id-vite",
	projectDir: "/work",
	state: "running",
	createdAt: 0,
	startedAt: 0,
	restartCount: 0,
	persist: false,
	detached: false,
	reportedBy: ["w1"],
};

beforeEach(() => {
	installTransportStubs();
	setState("daemons", new Map([[daemonsKey(vite), vite]]));
	connect();
	FakeWebSocket.instances.at(-1)!.onopen?.();
	dispatch({ type: "attached", scope: "w1" });
});

afterEach(() => {
	setState("daemons", new Map());
	restoreBrowserGlobals();
});

function lastCommand<T extends string>(type: T) {
	const cmd = posted.filter((c) => c.type === type).at(-1);
	if (cmd === undefined) throw new Error(`no ${type} command was sent`);
	return cmd as Extract<typeof cmd, { type: T }>;
}

describe("createDaemonControl", () => {
	test("restart sends the command for that process and stores the broker's answer", async () => {
		await createRoot(async (dispose) => {
			const control = createDaemonControl(() => vite);
			control.restart();
			const cmd = lastCommand("daemon_restart");
			expect(cmd).toMatchObject({ projectDir: "/work", name: "vite" });
			expect(control.busy()).toBe(true);
			dispatch({
				type: "daemon_control_result",
				id: cmd.id,
				ok: true,
				daemon: { ...vite, restartCount: 1, startedAt: 99 },
			});
			await flushMicrotasks();
			expect(control.busy()).toBe(false);
			expect(state.daemons.get(daemonsKey(vite))).toMatchObject({ restartCount: 1, startedAt: 99 });
			dispose();
		});
	});

	test("kill stores the exited process; a second action while one is pending sends nothing", async () => {
		await createRoot(async (dispose) => {
			const control = createDaemonControl(() => vite);
			control.stop();
			control.restart();
			expect(
				posted.filter((c) => c.type === "daemon_stop" || c.type === "daemon_restart"),
			).toHaveLength(1);
			dispatch({
				type: "daemon_control_result",
				id: lastCommand("daemon_stop").id,
				ok: true,
				daemon: { ...vite, state: "exited" },
			});
			await flushMicrotasks();
			expect(state.daemons.get(daemonsKey(vite))?.state).toBe("exited");
			dispose();
		});
	});

	test("a refused action leaves the roster entry alone and frees the row", async () => {
		await createRoot(async (dispose) => {
			const control = createDaemonControl(() => vite);
			control.restart();
			dispatch({
				type: "daemon_control_result",
				id: lastCommand("daemon_restart").id,
				ok: false,
				error: "broker unreachable",
			});
			await flushMicrotasks();
			expect(control.busy()).toBe(false);
			expect(state.daemons.get(daemonsKey(vite))).toEqual(vite);
			dispose();
		});
	});
});

describe("createDaemonLogs", () => {
	const answer = (text: string) =>
		dispatch({
			type: "daemon_logs_result",
			id: lastCommand("daemon_logs").id,
			ok: true,
			text,
			cursor: text.length,
			state: "running",
		});

	test("refresh loads the tail and keeps it while the next fetch is out", async () => {
		await createRoot(async (dispose) => {
			const logs = createDaemonLogs(() => vite);
			logs.refresh();
			expect(logs.view()).toEqual({ text: undefined, loading: true, error: undefined });
			answer("first");
			await flushMicrotasks();
			expect(logs.view()).toEqual({ text: "first", loading: false, error: undefined });
			logs.refresh();
			expect(logs.view()).toEqual({ text: "first", loading: true, error: undefined });
			answer("second");
			await flushMicrotasks();
			expect(logs.view().text).toBe("second");
			dispose();
		});
	});

	test("a failed refresh keeps the previous tail and reports why", async () => {
		await createRoot(async (dispose) => {
			const logs = createDaemonLogs(() => vite);
			logs.refresh();
			answer("tail");
			await flushMicrotasks();
			logs.refresh();
			dispatch({
				type: "daemon_logs_result",
				id: lastCommand("daemon_logs").id,
				ok: false,
				error: "daemon not found",
			});
			await flushMicrotasks();
			expect(logs.view()).toEqual({ text: "tail", loading: false, error: "daemon not found" });
			dispose();
		});
	});

	test("an answer to an older request does not overwrite the newer one", async () => {
		await createRoot(async (dispose) => {
			const logs = createDaemonLogs(() => vite);
			logs.refresh();
			const older = lastCommand("daemon_logs").id;
			logs.refresh();
			const newer = lastCommand("daemon_logs").id;
			dispatch({
				type: "daemon_logs_result",
				id: newer,
				ok: true,
				text: "new",
				cursor: 3,
				state: "running",
			});
			dispatch({
				type: "daemon_logs_result",
				id: older,
				ok: true,
				text: "old",
				cursor: 3,
				state: "running",
			});
			await flushMicrotasks();
			expect(logs.view().text).toBe("new");
			dispose();
		});
	});
});
