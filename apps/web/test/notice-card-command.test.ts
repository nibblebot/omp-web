/**
 * A forwarded command shows its name once (CMD-09): the echo row carries the
 * name, and the reply renders attached under it with no `/name →` prefix.
 * Idle and busy-now runs both echo through the same path, so one render
 * check covers both.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import * as solidWeb from "solid-js/web";
import { NoticeCard } from "../components/chat/transcript/cards/NoticeCard";
import type { ChatItem } from "../state";
import { installJsxShim, restoreJsxShim } from "./web.testkit";

type NoticeItem = Extract<ChatItem, { kind: "notice" }>;

function notice(extra: Partial<NoticeItem>): NoticeItem {
	return { kind: "notice", id: 1, level: "info", message: "", ...extra };
}

function render(item: NoticeItem): string {
	return solidWeb.renderToString(() => createComponent(NoticeCard, { item }));
}

function countOf(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

beforeAll(() => {
	installJsxShim();
});

afterAll(() => {
	restoreJsxShim();
});

describe("forwarded command echo and reply (jx0b, CMD-09)", () => {
	test("a command reply renders without a '/name →' prefix", () => {
		const html = render(notice({ message: "Listed 2 directories.", command: "/dirs" }));
		expect(html).not.toContain("/dirs");
		expect(html).not.toContain("→");
		expect(html).toContain("Listed 2 directories.");
		expect(html).toContain("msg-notice-reply");
	});

	test("the echo row and its reply show the command name exactly once", () => {
		const echo = render(notice({ level: "echo", message: "/dirs" }));
		const reply = render(notice({ message: "Listed 2 directories.", command: "/dirs" }));
		expect(countOf(echo + reply, "/dirs")).toBe(1);
		expect(echo).toContain("msg-notice-echo");
	});

	test("a notice without a command tag renders as a plain notice", () => {
		const html = render(notice({ message: "Fresh session; provider state reset." }));
		expect(html).not.toContain("msg-notice-reply");
		expect(html).toContain("Fresh session; provider state reset.");
	});
});
