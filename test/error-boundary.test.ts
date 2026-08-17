/**
 * dispatchRequest must wrap every handler in try/catch so a throwing route
 * yields JSON 500 ("internal server error") — the stats API can never return
 * HTML or an unhandled rejection.
 */
import { describe, expect, test } from "bun:test";
import { dispatchRequest, json } from "../fleet/stats/http";
import type { Route } from "../fleet/stats/types";

const req = (path: string): Request => new Request(`http://test.local${path}`);

describe("dispatchRequest error boundary", () => {
	test("sync handler throw → JSON 500", async () => {
		const registry: Route[] = [
			{
				method: "GET",
				pattern: /^\/ctl\/stats\/boom$/,
				handler: () => {
					throw new Error("kaboom");
				},
			},
		];
		const res = await dispatchRequest(req("/ctl/stats/boom"), registry);
		expect(res).not.toBeNull();
		expect(res!.status).toBe(500);
		expect(res!.headers.get("content-type")).toContain("application/json");
		expect(await res!.json()).toEqual({ error: "internal server error" });
	});

	test("async handler rejection → JSON 500", async () => {
		const registry: Route[] = [
			{
				method: "GET",
				pattern: /^\/ctl\/stats\/boom$/,
				handler: async () => {
					throw new Error("async kaboom");
				},
			},
		];
		const res = await dispatchRequest(req("/ctl/stats/boom"), registry);
		expect(res!.status).toBe(500);
		expect(await res!.json()).toEqual({ error: "internal server error" });
	});

	test("healthy handler response passes through untouched", async () => {
		const registry: Route[] = [
			{
				method: "GET",
				pattern: /^\/ctl\/stats\/ok$/,
				handler: () => json({ fine: true }),
			},
		];
		const res = await dispatchRequest(req("/ctl/stats/ok"), registry);
		expect(res!.status).toBe(200);
		expect(await res!.json()).toEqual({ fine: true });
	});

	test("method mismatch skips the route", async () => {
		const registry: Route[] = [
			{ method: "GET", pattern: /^\/ctl\/stats\/x$/, handler: () => json({}) },
		];
		const res = await dispatchRequest(
			new Request("http://test.local/ctl/stats/x", { method: "POST" }),
			registry,
		);
		expect(res).toBeNull();
	});

	test("no matching route → null", async () => {
		const res = await dispatchRequest(req("/nope"), []);
		expect(res).toBeNull();
	});
});
