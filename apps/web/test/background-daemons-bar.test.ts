/**
 * The background daemons strip lists only the selected session's workspace processes: the
 * fleet's merged roster stamps `reportedBy` with the daemonIds whose broker listed each
 * process, and the strip keeps the ones reported by `state.currentSessionId`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import * as solidWeb from "solid-js/web";
import { daemonsKey, type DaemonInfo } from "#lib/wire/protocol";
import { BackgroundDaemonsBar } from "../components/fleet/daemon/BackgroundDaemonsBar";
import { setState, state } from "../state";
import { installJsxShim, restoreJsxShim } from "./web.testkit";

const saved = { daemons: state.daemons, currentSessionId: state.currentSessionId };

beforeAll(() => {
	installJsxShim();
});

afterAll(() => {
	setState({ daemons: saved.daemons, currentSessionId: saved.currentSessionId });
	restoreJsxShim();
});

function proc(name: string, projectDir: string, reportedBy?: string[]): DaemonInfo {
	return {
		name,
		id: `${projectDir}/${name}`,
		projectDir,
		state: "running",
		createdAt: 0,
		startedAt: 0,
		restartCount: 0,
		persist: false,
		detached: false,
		...(reportedBy !== undefined ? { reportedBy } : {}),
	};
}

function render(currentSessionId: string, procs: DaemonInfo[]): string {
	setState({ currentSessionId, daemons: new Map(procs.map((d) => [daemonsKey(d), d])) });
	return solidWeb.renderToString(() => createComponent(BackgroundDaemonsBar, {}));
}

describe("BackgroundDaemonsBar", () => {
	const fleetRoster = [
		proc("vite-a", "/a", ["d1"]),
		proc("shared-dir", "/s", ["d1", "d2"]),
		proc("vite-b", "/b", ["d2"]),
	];

	test("lists only processes reported by the selected session", () => {
		const html = render("d1", fleetRoster);
		expect(html).toContain("vite-a");
		expect(html).toContain("shared-dir");
		expect(html).not.toContain("vite-b");
	});

	test("switching sessions swaps the listed workspace", () => {
		const html = render("d2", fleetRoster);
		expect(html).toContain("vite-b");
		expect(html).toContain("shared-dir");
		expect(html).not.toContain("vite-a");
	});

	test("renders nothing when no session is selected", () => {
		expect(render("", fleetRoster)).not.toContain("background-bar");
	});

	test("an entry no session reported is never listed", () => {
		expect(render("d1", [proc("orphan", "/a")])).not.toContain("orphan");
	});
});
