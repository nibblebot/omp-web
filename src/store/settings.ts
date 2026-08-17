import type { SettingsModel } from "../../shared/protocol";
import { fleetSettingsActive, setState } from "../state";
import { call } from "./transport";

/**
 * Settings domain (Phase 3 store facade split): TUI /settings parity. The
 * settings mirror (state.settingsModel/settingsLoading, settings_changed
 * frames) stays in state.ts alongside the mux.
 */

/** Server error message from a non-ok /ctl response: the {error} body when
 *  present, else the raw body text, else the HTTP status. */
async function ctlError(res: Response): Promise<string> {
	const body = await res.text().catch(() => "");
	try {
		const parsed = JSON.parse(body) as { error?: unknown };
		if (typeof parsed.error === "string" && parsed.error !== "") return parsed.error;
	} catch {
		// non-JSON body — fall through to the raw text
	}
	return body || String(res.status);
}

// ---------------------------------------------------------------------------
// Settings model (TUI /settings parity). getSettings/setSetting return a
// fresh authoritative model each time; settings_changed frames keep every
// tab's settings panel in sync. With no daemon attached in roster mode the
// /ctl settings endpoints back the panel instead (config.yml writes apply to
// new sessions); the session RPC resumes once a session is attached.
// ---------------------------------------------------------------------------
export function refreshSettings(): void {
	setState("settingsLoading", true);
	const load = fleetSettingsActive()
		? fetch("/ctl/settings")
				.then(async (res) => {
					if (!res.ok) throw await ctlError(res);
					return (await res.json()) as SettingsModel;
				})
				.then((m) => setState("settingsModel", m))
		: call("getSettings").then((m) => setState("settingsModel", m as SettingsModel));
	load
		.catch((err) => setState("error", String(err)))
		.finally(() => setState("settingsLoading", false));
}

/** Send one setting; the fresh model returned is authoritative, apply it. */
export function updateSetting(path: string, value: unknown): void {
	if (fleetSettingsActive()) {
		fetch("/ctl/settings/set", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path, value }),
		})
			.then(async (res) => {
				if (!res.ok) throw await ctlError(res);
				return (await res.json()) as SettingsModel;
			})
			.then((m) => setState("settingsModel", m))
			.catch((err) => setState("error", String(err)));
		return;
	}
	call("setSetting", [path, value])
		.then((m) => setState("settingsModel", m as SettingsModel))
		.catch((err) => setState("error", String(err)));
}
