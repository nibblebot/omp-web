/**
 * Up-volume driver shared by callback-tls-proxy.test.ts and its spawned
 * session half (callback-tls-proxy-session.testkit.ts): pushes a fixed number
 * of numbered frames through one real FleetCallback, paced by its queue, so a
 * single pair socket carries more than Bun's 128 MiB default request-body cap
 * (the reason the old HTTP up leg renewed its request every 128 MiB).
 */
import type { FleetCallback } from "../../session/fleet-callback";

/** Virtual stream the volume rides. */
export const VOLUME_STREAM = "browser/volume";
/** Payload pad per frame; the envelope stays under the 1 MiB single-envelope cap. */
export const VOLUME_PAD_BYTES = 768 * 1024;
/** 192 x 768 KiB = 144 MiB of payload, past the 128 MiB (134217728 byte) cap. */
export const VOLUME_FRAMES = 192;
export const VOLUME_BYTES = VOLUME_PAD_BYTES * VOLUME_FRAMES;
/** Queue depth the sender keeps ahead of the socket. */
const QUEUED_BYTES_TARGET = 2 * 1024 * 1024;

/** Send VOLUME_FRAMES numbered frames (`{ i, pad }`), waiting on the callback's drain whenever its queue is deep. */
export async function sendVolume(callback: FleetCallback): Promise<void> {
	const pad = "x".repeat(VOLUME_PAD_BYTES);
	for (let i = 0; i < VOLUME_FRAMES; i++) {
		while (callback.bufferedBytes(VOLUME_STREAM).stream >= QUEUED_BYTES_TARGET) {
			await new Promise<void>((resolve) => {
				const off = callback.onDrain(() => {
					off();
					resolve();
				});
			});
		}
		const result = callback.send({ streamId: VOLUME_STREAM, kind: "frame", payload: { i, pad } });
		if (result !== "sent") throw new Error(`volume frame ${i} was ${result}`);
	}
}
