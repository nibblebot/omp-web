/**
 * Cross-process monotonic clock.
 *
 * Bun's `process.hrtime.bigint()`, `Bun.nanoseconds()` and `performance.now()`
 * are relative to the process start, so values from two processes cannot be
 * subtracted. `monotonicNs()` reads `CLOCK_MONOTONIC` directly through libc,
 * the same absolute timeline in every process on the host. The fake model
 * stamps send times with it and clients stamp receive times with it.
 */
import { dlopen, FFIType, ptr } from "bun:ffi";

const CLOCK_MONOTONIC = 1;

const libc = dlopen("libc.so.6", {
	clock_gettime: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
});

const timespec = new BigInt64Array(2);
const timespecPtr = ptr(timespec);

/** Nanoseconds on the host's `CLOCK_MONOTONIC`, comparable across processes. */
export function monotonicNs(): bigint {
	if (libc.symbols.clock_gettime(CLOCK_MONOTONIC, timespecPtr) !== 0) {
		throw new Error("clock_gettime(CLOCK_MONOTONIC) failed");
	}
	return timespec[0] * 1_000_000_000n + timespec[1];
}
