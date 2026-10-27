import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { setState, state } from "../../state";
import { setNotifyEnabled } from "../../store/chat";

// Install a fake Notification global per case; restore it and the store fields this file writes.
const hadNotification = Reflect.has(globalThis, "Notification");
const original: unknown = Reflect.get(globalThis, "Notification");
let baseline: { enabled: boolean; permission: typeof state.notifyPermission };

/** Fake whose requestPermission answers `answer` (and records it as the new permission). */
function fakeNotification(
	permission: NotificationPermission,
	answer: NotificationPermission = permission,
) {
	const fake = {
		permission,
		requests: 0,
		requestPermission: async () => {
			fake.requests++;
			fake.permission = answer;
			return answer;
		},
	};
	Reflect.set(globalThis, "Notification", fake);
	return fake;
}

beforeAll(() => {
	baseline = { enabled: state.notifyEnabled, permission: state.notifyPermission };
});

afterAll(() => {
	setState("notifyEnabled", baseline.enabled);
	setState("notifyPermission", baseline.permission);
	if (hadNotification) Reflect.set(globalThis, "Notification", original);
	else Reflect.deleteProperty(globalThis, "Notification");
});

describe("setNotifyEnabled (the toggle is on only with granted permission)", () => {
	test("an undecided permission prompts, and a grant turns the toggle on", async () => {
		const fake = fakeNotification("default", "granted");
		await setNotifyEnabled(true);
		expect(fake.requests).toBe(1);
		expect(state.notifyEnabled).toBe(true);
		expect(state.notifyPermission).toBe("granted");
	});

	test("a dismissed or denied prompt leaves the toggle off and records the answer", async () => {
		fakeNotification("default", "default");
		await setNotifyEnabled(true);
		expect(state.notifyEnabled).toBe(false);
		expect(state.notifyPermission).toBe("default");

		fakeNotification("default", "denied");
		await setNotifyEnabled(true);
		expect(state.notifyEnabled).toBe(false);
		expect(state.notifyPermission).toBe("denied");
	});

	test("an existing grant turns on without prompting, and off always applies", async () => {
		const fake = fakeNotification("granted");
		await setNotifyEnabled(true);
		expect(fake.requests).toBe(0);
		expect(state.notifyEnabled).toBe(true);

		await setNotifyEnabled(false);
		expect(state.notifyEnabled).toBe(false);
	});

	test("a denied permission never prompts and stays off", async () => {
		const fake = fakeNotification("denied");
		await setNotifyEnabled(true);
		expect(fake.requests).toBe(0);
		expect(state.notifyEnabled).toBe(false);
	});

	test("without the Notification API the toggle stays off and reads unsupported", async () => {
		Reflect.deleteProperty(globalThis, "Notification");
		await setNotifyEnabled(true);
		expect(state.notifyEnabled).toBe(false);
		expect(state.notifyPermission).toBe("unsupported");
	});
});
