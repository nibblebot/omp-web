import { combined } from "./combined";
import type { Scenario } from "./env";
import { s1History, s1HistoryLarge } from "./s1-history";
import { s2Text } from "./s2-text";
import { s3Tools } from "./s3-tools";
import { s4Subagents } from "./s4-subagents";

/** Measured scenarios in run order. The liveness check is separate (`liveness.ts`). */
export const SCENARIOS: Scenario[] = [
	s1History,
	s1HistoryLarge,
	s2Text,
	s3Tools,
	s4Subagents,
	combined,
];
