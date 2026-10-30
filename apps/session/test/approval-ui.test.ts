/**
 * The web host's tool-approval dialog: ExtensionUIContext.approve rides a dedicated
 * `approve` ui_request and the browser's ui_response is read back as the SDK's
 * ExtensionApprovalAnswer. A frame tap plays the browser (the same seam
 * ask-tool.test.ts uses), answering exactly like index.ts's ui_response dispatch.
 */
import { afterAll, describe, expect, test } from "bun:test";
import type { ExtensionApprovalPrompt } from "@oh-my-pi/pi-coding-agent";
import { requestApproval } from "@oh-my-pi/pi-coding-agent/tools/approval";
import type { UiApprovalParams } from "#lib/wire/protocol";
import { setOnFrameTap, streams, type ClientConsumer } from "../client-delivery";
import type { CollabHostAdapter } from "../collab-host";
import type { SessionEntry } from "../session-entry";
import {
	buildUiContext,
	cancelEntryUiRequests,
	setCallbackBrowserStreamCount,
} from "../ui-context";

const entry = {
	handle: "s1",
	collab: { adapter: null as CollabHostAdapter | null },
	pendingUiRequests: new Map(),
} as unknown as SessionEntry;

const consumer = {
	id: 1,
	ws: { readyState: 1, getBufferedAmount: () => 0, send: () => 1, close: () => {} } as never,
	attached: "s1",
	lastSendAt: 0,
} as ClientConsumer;

const prompt = {
	full: "Allow tool: write\nPath: src/a.ts",
	compact: "Allow tool: write\nsrc/a.ts",
	session: "Approve write for this session",
	grants: [
		{
			scope: "folder",
			label: "Approve Directory: src",
			alwaysLabel: "Always Approve Directory: src",
		},
		{ scope: "target", label: "Approve File", alwaysLabel: "Always Approve File" },
	],
} as const;

let seen: Array<{ method: string; params: unknown }> = [];

/**
 * Run `ask` with a browser attached that answers each ui_request with `respond(params)`;
 * `undefined` plays a cancel (a ui_response without a result).
 */
async function withBrowser<T>(
	respond: (params: UiApprovalParams) => unknown,
	ask: () => Promise<T>,
): Promise<T> {
	seen = [];
	consumer.attached = "s1";
	streams.add(consumer);
	setCallbackBrowserStreamCount(() => 0);
	setOnFrameTap((frame) => {
		if (frame.type !== "ui_request") return;
		seen.push({ method: frame.method, params: frame.params });
		const pending = entry.pendingUiRequests.get(frame.id);
		if (!pending) return;
		entry.pendingUiRequests.delete(frame.id);
		pending.resolve(respond(frame.params as UiApprovalParams));
	});
	try {
		return await ask();
	} finally {
		streams.delete(consumer);
		setOnFrameTap(null);
		setCallbackBrowserStreamCount(null);
	}
}

afterAll(() => {
	streams.delete(consumer);
	setOnFrameTap(null);
	setCallbackBrowserStreamCount(null);
});

describe("approve over the session's browser UI context", () => {
	test("sends the prompt as an approve request without the compact rendering", async () => {
		const ui = buildUiContext(entry);
		await withBrowser(
			() => "once",
			() => ui.approve!(prompt),
		);
		expect(seen).toEqual([
			{
				method: "approve",
				params: { full: prompt.full, session: prompt.session, grants: [...prompt.grants] },
			},
		]);
	});

	test("omits session and grants when the prompt has none", async () => {
		const ui = buildUiContext(entry);
		await withBrowser(
			() => "once",
			() => ui.approve!({ full: "Allow tool: bash", compact: "Allow tool: bash" }),
		);
		expect(seen[0]?.params).toEqual({ full: "Allow tool: bash" });
	});

	test("once, session and grant answers reach the SDK as its answer union", async () => {
		const ui = buildUiContext(entry);
		const ask = (answer: unknown) =>
			withBrowser(
				() => answer,
				() => ui.approve!(prompt),
			);
		expect(await ask("once")).toBe("once");
		expect(await ask("session")).toBe("session");
		expect(await ask({ grant: "folder", always: false })).toEqual({
			grant: "folder",
			always: false,
		});
		expect(await ask({ grant: "target", always: true })).toEqual({
			grant: "target",
			always: true,
		});
	});

	test("a cancel, deny or answer the prompt does not offer is deny", async () => {
		const ui = buildUiContext(entry);
		const ask = (answer: unknown, offered: ExtensionApprovalPrompt = prompt) =>
			withBrowser(
				() => answer,
				() => ui.approve!(offered),
			);
		expect(await ask(undefined)).toBe("deny");
		expect(await ask("deny")).toBe("deny");
		expect(await ask("approve everything")).toBe("deny");
		expect(await ask("session", { full: "Allow tool: bash", compact: "Allow tool: bash" })).toBe(
			"deny",
		);
		expect(
			await ask(
				{ grant: "folder", always: true },
				{ full: "Allow tool: bash", compact: "Allow tool: bash" },
			),
		).toBe("deny");
	});

	test("Stop cancels a pending approval as deny", async () => {
		const ui = buildUiContext(entry);
		seen = [];
		consumer.attached = "s1";
		streams.add(consumer);
		setCallbackBrowserStreamCount(() => 0);
		try {
			// The dialog registers synchronously, before approve's first await.
			const answer = ui.approve!(prompt);
			expect(entry.pendingUiRequests.size).toBe(1);
			cancelEntryUiRequests(entry);
			expect(await answer).toBe("deny");
		} finally {
			streams.delete(consumer);
			setCallbackBrowserStreamCount(null);
		}
	});

	test("the SDK's requestApproval uses the dialog and honors the browser's answer", async () => {
		const ui = buildUiContext(entry);
		const answer = await withBrowser(
			() => "session",
			() => requestApproval(ui, { name: "bash" }, {}, { sessionSubject: "bash" }),
		);
		expect(answer).toBe("session");
		expect(seen[0]?.method).toBe("approve");
	});

	test("a collab guest answers through the select labels", async () => {
		const ui = buildUiContext(entry);
		const requests: unknown[] = [];
		const guest = (label: string | undefined) =>
			({
				isLive: true,
				writableGuestCount: 1,
				hostName: "host",
				announceDialogAnswered: () => {},
				requestGuestUi: (draft: unknown) => {
					requests.push(draft);
					return Promise.resolve({ kind: "answered", value: label, by: "guest", peer: 2 });
				},
			}) as unknown as CollabHostAdapter;
		try {
			entry.collab.adapter = guest("Always Approve Directory: src");
			expect(await ui.approve!(prompt)).toEqual({ grant: "folder", always: true });
			expect(requests[0]).toEqual({
				kind: "select",
				title: prompt.full,
				options: [
					"Approve Directory: src",
					"Approve File",
					"Always Approve Directory: src",
					"Always Approve File",
					"Approve Once",
					"Approve write for this session",
					"Deny",
				],
			});
			entry.collab.adapter = guest("Approve write for this session");
			expect(await ui.approve!(prompt)).toBe("session");
			entry.collab.adapter = guest("Deny");
			expect(await ui.approve!(prompt)).toBe("deny");
			entry.collab.adapter = guest(undefined);
			expect(await ui.approve!(prompt)).toBe("deny");
		} finally {
			entry.collab.adapter = null;
		}
	});
});

describe("secret input", () => {
	test("is masked for the browser and never offered to collab guests", async () => {
		const ui = buildUiContext(entry);
		const requests: unknown[] = [];
		entry.collab.adapter = {
			isLive: true,
			writableGuestCount: 1,
			hostName: "host",
			announceDialogAnswered: () => {},
			requestGuestUi: (draft: unknown) => {
				requests.push(draft);
				return Promise.resolve({ kind: "answered", value: "guest", by: "guest", peer: 2 });
			},
		} as unknown as CollabHostAdapter;
		try {
			const secret = await withBrowser(
				() => "hunter2",
				() => ui.input!("Token", "paste it", { secret: true }),
			);
			expect(secret).toBe("hunter2");
			expect(seen[0]).toEqual({
				method: "input",
				params: { title: "Token", placeholder: "paste it", secret: true },
			});
			expect(requests).toEqual([]);

			// A plain input still reaches the guest as an editor prefill and carries no flag.
			await withBrowser(
				() => "web",
				() => ui.input!("Branch", "feature/x"),
			);
			expect(seen[0]?.params).toEqual({ title: "Branch", placeholder: "feature/x" });
			expect(requests).toEqual([{ kind: "editor", title: "Branch", prefill: "feature/x" }]);
		} finally {
			entry.collab.adapter = null;
		}
	});
});
