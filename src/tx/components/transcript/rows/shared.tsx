/**
 * Shared transcript row building blocks: raw-JSON fallback, card containers,
 * collapsible <details> wiring, and scalar formatting helpers.
 */
import { Show, useContext } from "solid-js";
import type { JSX } from "solid-js";
import type { RawEntry } from "../../../api";
import { entryTimestamp, entryTypeLabel, rawJson, shortSummary, str, systemDetail } from "../../../util/entries";
import { formatDateTime } from "../../../util/format";
import { RowStateCtx, useRowCollapse } from "../collapse";

/** Stable details key for one <details> inside a row; survives remounts + page appends. */
export function detailsKey(entry: RawEntry, purpose: string): string {
  return `${str(entry.id) || "no-id"}:${purpose}`;
}

/** Row aria-label: entry type + short summary. */
export function rowAriaLabel(entry: RawEntry): string {
  const summary = shortSummary(entry);
  const label = entryTypeLabel(entry);
  return summary !== "" ? `${label}: ${summary}` : label;
}

/**
 * A transcript <details> with reactive open state: manual toggles are tracked
 * by stable key, so page-appends and virtual-row remounts never clobber what
 * the user set by hand.
 */
export function ToggleDetails(props: {
  entry: RawEntry;
  purpose: string;
  class?: string;
  summary: JSX.Element;
  children?: JSX.Element;
}) {
  const ctx = useContext(RowStateCtx);
  const key = () => detailsKey(props.entry, props.purpose);
  return (
    <details
      class={props.class}
      open={ctx ? ctx.detailsOpen(key()) : false}
      onToggle={(ev) => ctx?.setDetailsOpen(key(), ev.currentTarget.open)}
    >
      <summary>{props.summary}</summary>
      {props.children}
    </details>
  );
}

/** Universal raw-JSON fallback — lives at the right end of each row's header line. */
export function RawJson(props: { entry: RawEntry }) {
  return (
    <ToggleDetails entry={props.entry} purpose="raw" class="raw-entry" summary="raw">
      <pre>{rawJson(props.entry)}</pre>
    </ToggleDetails>
  );
}

/** Scalar display value, or null when the payload isn't scalar. */
export function scalar(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  return null;
}

export function prettyJson(v: unknown): string {
  if (v === undefined) return "undefined";
  try {
    const s = JSON.stringify(v, null, 2);
    return typeof s === "string" ? s : String(v);
  } catch {
    return String(v);
  }
}

/** Typed card container for rich system entries: collapsible header (+raw) + body. */
export function SysCard(props: { entry: RawEntry; label: string; children?: JSX.Element }) {
  const ts = entryTimestamp(props.entry);
  const row = useRowCollapse(props.entry);
  return (
    <div classList={{ "sys-card": true, collapsed: row.collapsed() }}>
      <div class="sys-head">
        <button class="sys-toggle" onClick={row.toggle} aria-expanded={!row.collapsed()} aria-label={rowAriaLabel(props.entry)}>
          <span class="meta-time">{ts !== null ? formatDateTime(ts) : ""}</span>
          <span class="sys-label">{props.label}</span>
        </button>
        <RawJson entry={props.entry} />
      </div>
      <Show when={props.children !== undefined}>
        <div class="sys-body">{props.children}</div>
      </Show>
    </div>
  );
}

/** Thin one-line system row (kept for simple entries) + raw JSON in the row. */
export function GenericSysRow(props: { entry: RawEntry; label: string; detail?: string }) {
  const ts = entryTimestamp(props.entry);
  const detail = props.detail !== undefined ? props.detail : systemDetail(props.entry);
  return (
    <div class="sys-block">
      <div class="sys-row">
        <span class="meta-time">{ts !== null ? formatDateTime(ts) : ""}</span>
        <span class="sys-label">{props.label}</span>
        <Show when={detail !== ""}>
          <span class="sys-detail">{detail}</span>
        </Show>
        <RawJson entry={props.entry} />
      </div>
    </div>
  );
}

/** key/value line; hidden when the value isn't a present scalar. */
export function Kv(props: { k: string; v: unknown }) {
  const s = scalar(props.v);
  return (
    <Show when={s !== null}>
      <div class="kv-pair">
        <span class="kv-key">{props.k}</span>
        <span class="kv-val">{s}</span>
      </div>
    </Show>
  );
}

/** One entry of an arbitrary `data` object: scalar → kv pair, nested → collapsed JSON. */
export function DataKv(props: { k: string; v: unknown; entry: RawEntry }) {
  const s = scalar(props.v);
  return (
    <Show
      when={s !== null}
      fallback={
        <ToggleDetails entry={props.entry} purpose={`kv-json:${props.k}`} class="kv-json" summary={props.k}>
          <pre>{prettyJson(props.v)}</pre>
        </ToggleDetails>
      }
    >
      <div class="kv-pair">
        <span class="kv-key">{props.k}</span>
        <span class="kv-val">{s}</span>
      </div>
    </Show>
  );
}
