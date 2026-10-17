import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { notificationsBlocked } from "../../store/chat";

// Install a fake Notification global for each case and restore the original afterward.
const hadNotification = Reflect.has(globalThis, "Notification");
const original: unknown = Reflect.get(globalThis, "Notification");

function stubPermission(permission: "default" | "granted" | "denied" | undefined): void {
	if (permission === undefined) {
		Reflect.deleteProperty(globalThis, "Notification");
		return;
	}
	Reflect.set(globalThis, "Notification", { permission });
}

beforeAll(() => {
	stubPermission(undefined);
});

afterAll(() => {
	if (hadNotification) Reflect.set(globalThis, "Notification", original);
	else Reflect.deleteProperty(globalThis, "Notification");
});

describe("notificationsBlocked", () => {
	test("is true only when the browser has denied notification permission", () => {
		stubPermission("denied");
		expect(notificationsBlocked()).toBe(true);
	});

	test("is false while permission is default or granted", () => {
		stubPermission("default");
		expect(notificationsBlocked()).toBe(false);
		stubPermission("granted");
		expect(notificationsBlocked()).toBe(false);
	});

	test("is false where the Notification API is absent", () => {
		stubPermission(undefined);
		expect(notificationsBlocked()).toBe(false);
	});
});
