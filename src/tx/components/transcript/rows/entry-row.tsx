/**
 * Row dispatch: entry type → renderer. Keeps all original row types working,
 * now fed by the shared pairing maps from transcript/pairing.ts.
 */
import type { RawEntry } from "../../../api";
import {
  labelOf,
  messageRole,
  modelChangeOf,
  serviceTierChangeOf,
  thinkingLevelChangeOf,
  toolCallIdOf,
} from "../../../util/entries";
import type { PairingMaps } from "../pairing";
import { GenericSysRow, scalar } from "./shared";
import {
  CompactionRow,
  CustomMessageRow,
  CustomRow,
  ModeChangeRow,
  SessionHeader,
  SessionInitRow,
  TitleChangeRow,
  TtsrInjectionRow,
} from "./system";
import { AssistantMsg, DeveloperMsg, FileMentionMsg, ToolResultMsg, UserMsg } from "./messages";

export function EntryRow(props: { entry: RawEntry; pairing: PairingMaps }) {
  const e = props.entry;
  const type = typeof e.type === "string" ? e.type : "unknown";

  if (type === "message") {
    const role = messageRole(e);
    if (role === "assistant") return <AssistantMsg entry={e} pairing={props.pairing} />;
    if (role === "user") return <UserMsg entry={e} />;
    if (role === "toolResult") {
      // Paired results render inside their call card; only unpaired ones stay standalone.
      const id = toolCallIdOf(e);
      if (id !== null && props.pairing.calls.get(id)?.hasCall === true) return null;
      return <ToolResultMsg entry={e} calls={props.pairing.calls} />;
    }
    if (role === "developer") return <DeveloperMsg entry={e} />;
    if (role === "fileMention") return <FileMentionMsg entry={e} />;
    return <GenericSysRow entry={e} label={`message[${role ?? "?"}]`} />;
  }
  // The title slot (line 1) duplicates the header — skip it as noise.
  if (type === "title") return null;
  switch (type) {
    case "session":
      return <SessionHeader entry={e} />;
    case "session_init":
      return <SessionInitRow entry={e} />;
    case "mode_change":
      return <ModeChangeRow entry={e} />;
    case "model_change": {
      const m = modelChangeOf(e);
      const detail =
        m === null
          ? ""
          : [m.model, m.role !== null ? `→ ${m.role}` : null, m.resolvedModelIsFallback === true ? "(fallback)" : null]
              .filter((p) => p !== null)
              .join(" ");
      return <GenericSysRow entry={e} label="model_change" detail={detail} />;
    }
    case "thinking_level_change": {
      const t = thinkingLevelChangeOf(e);
      const configured = scalar(t?.configured);
      const detail =
        t === null
          ? ""
          : [t.thinkingLevel, configured !== null ? `· configured ${configured}` : null]
              .filter((p) => p !== null)
              .join(" ");
      return <GenericSysRow entry={e} label="thinking_level_change" detail={detail} />;
    }
    case "service_tier_change":
      // serviceTier may legitimately be null — the effective tier is then "default".
      return <GenericSysRow entry={e} label="service_tier_change" detail={serviceTierChangeOf(e)?.serviceTier ?? "default"} />;
    case "title_change":
      return <TitleChangeRow entry={e} />;
    case "ttsr_injection":
      return <TtsrInjectionRow entry={e} />;
    case "compaction":
      return <CompactionRow entry={e} />;
    case "label":
      return <GenericSysRow entry={e} label="label" detail={labelOf(e) ?? ""} />;
    case "credential_pin":
      return <GenericSysRow entry={e} label="credential_pin" />;
    case "custom_message":
      return <CustomMessageRow entry={e} />;
    case "custom":
      return <CustomRow entry={e} />;
    default:
      return <GenericSysRow entry={e} label={type} />;
  }
}
