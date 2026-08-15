/**
 * Tool-call pairing over ALL loaded transcript entries.
 *
 * The pairing maps are computed ONCE per entries change in a createMemo
 * (never per-row at mount), so toolResults arriving on later pages still
 * pair with their call's execution-start marker — wherever the call lives
 * in the loaded range (audit Phase 1 finding). Calls with an execution
 * start but no result yet in the loaded range read as `hasResult: false`
 * and render a "pending…" badge.
 */
import { createMemo, type Accessor } from "solid-js";
import type { RawEntry } from "../../api";
import { contentBlocks, isMessage, messageRole, str, toolCallIdOf, toolExecutionStartOf } from "../../util/entries";

export interface ToolCallInfo {
  /** Tool name from the assistant message's toolCall block ("" when not loaded yet). */
  name: string;
  /** Execution-start marker timestamp (epoch ms), when the session records one. */
  startedAt: number | null;
  /** true once a toolResult for this id exists anywhere in the loaded entries. */
  hasResult: boolean;
  /** true when the assistant message carrying the toolCall block is loaded. */
  hasCall: boolean;
}

export interface PairingMaps {
  /** toolCallId → call info (toolCall blocks + execution-start markers + results). */
  calls: Map<string, ToolCallInfo>;
  /** toolCallId → toolResult entries, for nesting results inside their call card. */
  results: Map<string, RawEntry[]>;
}

/**
 * Single O(n) scan over all loaded entries. Pure — unit-tested in test/.
 */
export function pairToolCalls(entries: readonly RawEntry[]): PairingMaps {
  const calls = new Map<string, ToolCallInfo>();
  const results = new Map<string, RawEntry[]>();
  for (const e of entries) {
    if (!isMessage(e)) continue;
    const role = messageRole(e);
    if (role === "assistant") {
      for (const b of contentBlocks(e)) {
        if (b.type !== "toolCall" || typeof b.id !== "string") continue;
        const prev = calls.get(b.id);
        calls.set(b.id, {
          name: str(b.name) || prev?.name || "",
          startedAt: prev?.startedAt ?? null,
          hasResult: prev?.hasResult ?? false,
          hasCall: true,
        });
      }
    } else if (role === "toolResult") {
      const id = toolCallIdOf(e);
      if (id === null) continue;
      const arr = results.get(id);
      if (arr) arr.push(e);
      else results.set(id, [e]);
      const prev = calls.get(id);
      calls.set(id, {
        name: prev?.name ?? "",
        startedAt: prev?.startedAt ?? null,
        hasResult: true,
        hasCall: prev?.hasCall ?? false,
      });
    }
  }
  // Execution-start markers may appear on an earlier page than the assistant
  // message — fill startedAt without clobbering name/hasResult/hasCall.
  for (const e of entries) {
    const st = toolExecutionStartOf(e);
    if (st === null) continue;
    const prev = calls.get(st.toolCallId);
    calls.set(st.toolCallId, {
      name: prev?.name ?? "",
      startedAt: st.startedAtMs,
      hasResult: prev?.hasResult ?? false,
      hasCall: prev?.hasCall ?? false,
    });
  }
  return { calls, results };
}

/**
 * Reactive pairing memo — recomputed once per entries change, shared by every
 * row. Rows read the returned Maps; they never build their own pairing.
 */
export function createPairingMaps(entries: Accessor<readonly RawEntry[]>): Accessor<PairingMaps> {
  return createMemo(() => pairToolCalls(entries()));
}
