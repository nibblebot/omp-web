/** Direct cases for the fleet's isJsonRequest (mutations must be application/json). */
import { describe, expect, test } from "bun:test";
import { isJsonRequest } from "../browser-guard";

function req(headers: Record<string, string>): Request {
	return new Request("http://127.0.0.1:4722/ctl/projects", { method: "POST", headers });
}

describe("isJsonRequest", () => {
	test("accepts application/json with parameters and any case", () => {
		expect(isJsonRequest(req({ "content-type": "application/json; charset=utf-8" }))).toBe(true);
		expect(isJsonRequest(req({ "content-type": "Application/JSON" }))).toBe(true);
	});

	test("refuses other media types and a missing Content-Type", () => {
		expect(isJsonRequest(req({ "content-type": "text/plain" }))).toBe(false);
		expect(isJsonRequest(req({ "content-type": "application/jsonx" }))).toBe(false);
		expect(isJsonRequest(req({}))).toBe(false);
	});
});
