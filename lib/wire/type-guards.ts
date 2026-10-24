/** A non-null, non-array object; its fields stay `unknown`. The one guard for untrusted wire and tool-details shapes. */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
