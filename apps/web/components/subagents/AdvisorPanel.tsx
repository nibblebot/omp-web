import { createResource, createSignal, For, Match, Show, Switch, type Component } from "solid-js";
import { call, pushNotice } from "../../state";
import { ConfirmButton } from "../shared/ConfirmButton";

/**
 * Advisor panel: config/status/transcript for the SDK advisor runtime.
 * Read-only by contract — no composer, no input element. All reads go through
 * the wire methods (advisorGetStatus/advisorConfigure/advisorTranscript in
 * lib/wire/protocol.ts) via casted call() — rejection-tolerant:
 * unknown-method answers render as capability-unavailable, never as empty
 * success. Local DTOs below stay JSON-safe and additive.
 */

// Local DTOs (proposed to P0; kept JSON-safe and additive).
interface AdvisorOverviewEntry {
	name: string;
	status: string;
	yielded?: boolean;
}
interface AdvisorOverview {
	configured: boolean;
	active: boolean;
	advisors: AdvisorOverviewEntry[];
}
interface AdvisorStats {
	cost?: number;
	tokens?: number;
	messages?: number;
	context?: unknown;
}
interface AdvisorHistoryPage {
	text: string;
	nextCursor?: string | null;
}

async function tryCall<T>(
	method: string,
	args: unknown[],
): Promise<{ data?: T; unavailable?: string }> {
	try {
		return { data: (await call(method as never, args)) as T };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.includes("Unknown method")) return { unavailable: message };
		throw err;
	}
}

/** Advisor is read-only: this component renders no input element by contract. */
export const AdvisorPanel: Component = () => {
	const [overview, { refetch: refetchOverview }] = createResource(
		async (): Promise<AdvisorOverview | { unavailable: string }> => {
			const res = await tryCall<AdvisorOverview>("advisorGetStatus", []);
			return res.data ?? { unavailable: res.unavailable ?? "unknown" };
		},
	);
	const [warnings] = createResource(async (): Promise<string[] | { unavailable: string }> => {
		const res = await tryCall<unknown>("advisorConfigure", [{ probe: true }]);
		if (res.data === undefined) return { unavailable: res.unavailable ?? "unknown" };
		if (Array.isArray(res.data) && res.data.every((entry) => typeof entry === "string"))
			return res.data;
		if (res.data !== null && typeof res.data === "object" && "warnings" in res.data) {
			const warnings = res.data.warnings;
			if (Array.isArray(warnings) && warnings.every((entry) => typeof entry === "string"))
				return warnings;
		}
		return [];
	});
	const [stats] = createResource(async (): Promise<AdvisorStats | { unavailable: string }> => {
		const res = await tryCall<AdvisorStats>("advisorGetStatus", [{ stats: true }]);
		return res.data ?? { unavailable: res.unavailable ?? "unknown" };
	});
	const [compact, setCompact] = createSignal(true);
	const [history, setHistory] = createSignal<AdvisorHistoryPage | null>(null);
	const [historyError, setHistoryError] = createSignal<string | null>(null);
	const [loading, setLoading] = createSignal(false);
	const [toggling, setToggling] = createSignal(false);
	const [pendingDisable, setPendingDisable] = createSignal(false);

	const loadHistory = async (): Promise<void> => {
		setLoading(true);
		setHistoryError(null);
		try {
			// Raw dump (compact:false) is the deliberate second click: callers arm
			// via ConfirmButton before requesting full text.
			const res = await tryCall<unknown>("advisorTranscript", [{ compact: compact() }]);
			if (res.data === undefined)
				setHistoryError(`advisor history unavailable: ${res.unavailable}`);
			else if (typeof res.data === "string") setHistory({ text: res.data });
			else if (
				res.data !== null &&
				typeof res.data === "object" &&
				"text" in res.data &&
				typeof res.data.text === "string"
			) {
				const cursor = "nextCursor" in res.data ? res.data.nextCursor : null;
				setHistory({ text: res.data.text, nextCursor: typeof cursor === "string" ? cursor : null });
			} else setHistory({ text: JSON.stringify(res.data) });
		} catch (err) {
			setHistoryError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
	};

	const setEnabled = async (enabled: boolean): Promise<void> => {
		setToggling(true);
		try {
			const res = await tryCall("advisorConfigure", [{ enabled }]);
			if (res.data === undefined) {
				pushNotice(
					"error",
					`advisor ${enabled ? "enable" : "disable"} unavailable: ${res.unavailable}`,
				);
			} else {
				pushNotice(
					"info",
					enabled
						? "advisor enabled — live advisories resume"
						: "advisor disabled — live advisories stop",
				);
				setPendingDisable(false);
				void refetchOverview();
			}
		} catch (err) {
			pushNotice("error", err instanceof Error ? err.message : String(err));
		} finally {
			setToggling(false);
		}
	};

	const disableRunning = (running: boolean): void => {
		// Disable-while-running uses an explicit confirm (ConfirmButton below).
		if (running && !pendingDisable()) {
			setPendingDisable(true);
			return;
		}
		void setEnabled(false);
	};

	return (
		<div class="subagent-list">
			<Switch>
				<Match when={overview.loading}>
					<div class="tool-collapsed-note">loading advisor status…</div>
				</Match>
				<Match when={overview.error}>
					<div class="msg-notice">{String(overview.error)}</div>
				</Match>
				<Match
					when={(() => {
						const o = overview();
						return o !== undefined && typeof o === "object" && "unavailable" in o;
					})()}
				>
					<div class="tool-collapsed-note">
						advisor status unavailable:{" "}
						{(() => {
							const o = overview();
							return o !== undefined &&
								typeof o === "object" &&
								"unavailable" in o &&
								typeof o.unavailable === "string"
								? o.unavailable
								: "unknown";
						})()}
					</div>
				</Match>
				<Match
					when={(() => {
						const o = overview();
						return o !== undefined && typeof o === "object" && "advisors" in o ? o : undefined;
					})()}
					keyed
				>
					{(raw) => {
						if (!("advisors" in raw)) return null;
						const advisors = raw.advisors;
						if (!Array.isArray(advisors)) return null;
						const configured =
							"configured" in raw && typeof raw.configured === "boolean" ? raw.configured : false;
						const running = "active" in raw && typeof raw.active === "boolean" ? raw.active : false;
						return (
							<div class="goal-panel">
								<div class="goal-meta">
									<span class="picker-label">advisor</span>{" "}
									{configured ? "configured" : "not configured"} · {running ? "active" : "idle"}
								</div>
								<For each={advisors}>
									{(entry) => {
										if (entry === null || typeof entry !== "object") return null;
										const name =
											"name" in entry && typeof entry.name === "string" ? entry.name : "advisor";
										const status =
											"status" in entry && typeof entry.status === "string"
												? entry.status
												: "unknown";
										const yielded = "yielded" in entry ? entry.yielded : undefined;
										return (
											<div class="goal-meta">
												<span class="picker-label">{name}</span> {status}
												{typeof yielded === "boolean" && (
													<span class="picker-detail"> · yielded: {String(yielded)}</span>
												)}
											</div>
										);
									}}
								</For>
								<div class="goal-actions">
									<button type="button" disabled={toggling()} onClick={() => void setEnabled(true)}>
										enable
									</button>
									<ConfirmButton
										label={pendingDisable() ? "disable running advisor?" : "disable"}
										confirmLabel="confirm disable"
										disabled={toggling()}
										onConfirm={() => {
											if (running && !pendingDisable()) setPendingDisable(true);
											else void setEnabled(false);
										}}
									/>
									<Show when={running}>
										<button type="button" onClick={() => disableRunning(true)}>
											stop advisories
										</button>
									</Show>
								</div>
							</div>
						);
					}}
				</Match>
			</Switch>

			<Show
				when={(() => {
					const w = warnings();
					return Array.isArray(w) && w.length > 0;
				})()}
			>
				<div class="goal-panel">
					<div class="goal-meta">
						<span class="picker-label">config warnings</span>
					</div>
					<For each={Array.isArray(warnings()) ? (warnings() as string[]) : []}>
						{(w) => <div class="msg-notice">{w}</div>}
					</For>
				</div>
			</Show>

			<Show
				when={(() => {
					const s = stats();
					return s !== undefined && typeof s === "object" && !("unavailable" in s);
				})()}
			>
				<div class="goal-meta">
					<span class="picker-label">stats</span> cost{" "}
					{(() => {
						const s = stats();
						return s !== undefined && typeof s === "object" && "cost" in s
							? String(s.cost ?? "n/a")
							: "n/a";
					})()}{" "}
					· tokens{" "}
					{(() => {
						const s = stats();
						return s !== undefined && typeof s === "object" && "tokens" in s
							? String(s.tokens ?? "n/a")
							: "n/a";
					})()}{" "}
					· messages{" "}
					{(() => {
						const s = stats();
						return s !== undefined && typeof s === "object" && "messages" in s
							? String(s.messages ?? "n/a")
							: "n/a";
					})()}
				</div>
			</Show>

			<div class="goal-panel">
				<div class="goal-meta">
					<span class="picker-label">transcript</span>
					<span class="picker-detail">
						note/concern/blocker severity arrives via live advisory stream; this dump is raw
						transcript
					</span>
				</div>
				<div class="subagent-controls" role="group" aria-label="Transcript density">
					<button
						type="button"
						aria-pressed={compact()}
						disabled={loading()}
						onClick={() => setCompact(true)}
					>
						compact
					</button>
					<button type="button" disabled={loading()} onClick={() => void loadHistory()}>
						{loading() ? "loading…" : "load transcript"}
					</button>
					<Show when={!compact()}>
						<ConfirmButton
							label="load raw full dump"
							confirmLabel="confirm raw dump"
							disabled={loading()}
							onConfirm={() => void loadHistory()}
						/>
					</Show>
					<button type="button" aria-pressed={!compact()} onClick={() => setCompact(false)}>
						raw
					</button>
				</div>
				<Show when={!compact()}>
					<div class="msg-notice">warning: raw dump may disclose prompts/code/credentials</div>
				</Show>
				<Show when={historyError()}>{(err) => <div class="msg-notice">{err()}</div>}</Show>
				<Show when={history()}>
					{(page) => (
						<pre class="dim-block" style={{ margin: "0", "white-space": "pre-wrap" }}>
							{page().text}
						</pre>
					)}
				</Show>
				<div class="tool-collapsed-note">advisor is read-only — no composer.</div>
			</div>
		</div>
	);
};
