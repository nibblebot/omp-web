/** True on touch-first devices (coarse primary pointer). Used for touch-only affordances; mouse paths stay unchanged. */
export const isCoarsePointer = (): boolean =>
	typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
