/**
 * What a daemon row needs besides the roster entry: the ready endpoint text, a ticking uptime,
 * the restart/kill actions and the log tail of an expanded row. Rows are keyed by `daemonsKey`.
 */
import { createSignal, onCleanup, onMount, type Accessor } from "solid-js";
import { daemonsKey, type DaemonInfo } from "#lib/wire/protocol";
import { requestDaemonLogs, restartDaemon, setState, stopDaemon } from "../state";
import { reportError } from "../store/toasts";
import { formatUptime } from "../text/uptime";
import { createNow } from "./clock";

/** The ready endpoint as `host:port`, when the daemon declared one. */
export function daemonEndpoint(daemon: DaemonInfo): string | undefined {
	return daemon.readyPort === undefined
		? undefined
		: `${daemon.readyHost ?? "127.0.0.1"}:${daemon.readyPort}`;
}

/** Time since the daemon started, re-read every second while the owner lives. */
export function createDaemonUptime(daemon: Accessor<DaemonInfo>): Accessor<string> {
	const now = createNow();
	return () => formatUptime(now() - daemon().startedAt);
}

export interface DaemonControl {
	busy: Accessor<boolean>;
	restart: () => void;
	stop: () => void;
}

/** Restart and kill for one daemon; the broker's answer replaces the roster entry, a failure toasts. One command at a time. */
export function createDaemonControl(daemon: Accessor<DaemonInfo>): DaemonControl {
	const [busy, setBusy] = createSignal(false);
	const run = async (command: typeof restartDaemon): Promise<void> => {
		if (busy()) return;
		const current = daemon();
		setBusy(true);
		try {
			const info = await command(current.projectDir, current.name);
			setState("daemons", (daemons) => new Map(daemons).set(daemonsKey(current), info));
		} catch (err) {
			reportError(err);
		} finally {
			setBusy(false);
		}
	};
	return { busy, restart: () => void run(restartDaemon), stop: () => void run(stopDaemon) };
}

export interface DaemonLogView {
	/** The latest tail; undefined until the first answer. A refresh keeps the previous tail until it lands. */
	text: string | undefined;
	loading: boolean;
	error: string | undefined;
}

export interface DaemonLogs {
	view: Accessor<DaemonLogView>;
	refresh: () => void;
}

/** The log tail of one daemon: fetched when the owner mounts, again on `refresh`. Answers that arrive after a newer request or after the owner is gone are dropped. */
export function createDaemonLogs(daemon: Accessor<DaemonInfo>): DaemonLogs {
	const [view, setView] = createSignal<DaemonLogView>({
		text: undefined,
		loading: true,
		error: undefined,
	});
	let latest = 0;
	onCleanup(() => {
		latest = -1;
	});
	const refresh = (): void => {
		if (latest < 0) return;
		const request = ++latest;
		const { projectDir, name } = daemon();
		setView((prev) => ({ ...prev, loading: true, error: undefined }));
		requestDaemonLogs(projectDir, name).then(
			(result) => {
				if (request === latest) setView({ text: result.text, loading: false, error: undefined });
			},
			(err: unknown) => {
				if (request !== latest) return;
				const error = err instanceof Error ? err.message : String(err);
				setView((prev) => ({ ...prev, loading: false, error }));
			},
		);
	};
	onMount(refresh);
	return { view, refresh };
}
