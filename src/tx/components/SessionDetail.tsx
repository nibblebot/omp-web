import { Show, createResource, createSignal } from "solid-js";
import { api } from "../api";
import { basename, folderOf, formatCompact, formatMs } from "../util/format";
import { AnalyticsView } from "./AnalyticsView";
import { TranscriptView } from "./transcript";
import { SubagentsView } from "./SubagentsView";

type Tab = "analytics" | "transcript" | "subagents";

const TABS: { id: Tab; label: string }[] = [
  { id: "analytics", label: "Analytics" },
  { id: "transcript", label: "Transcript" },
  { id: "subagents", label: "Subagents" },
];

interface SessionDetailProps {
  file: string;
  /** bumped after a stats sync so analytics data refetches */
  syncTick: () => number;
  /** called after a successful stats sync */
  onSynced: () => void;
}

/**
 * Session detail: header + Analytics | Transcript | Subagents tabs.
 * Tabs stay mounted (CSS-hidden) so loaded transcript pages survive tab switches.
 */
export function SessionDetail(props: SessionDetailProps) {
  const file = () => props.file;

  const [tab, setTab] = createSignal<Tab>("analytics");
  /** Transcript tool filter — shared: analytics table rows set it, transcript applies it. */
  const [toolFilter, setToolFilter] = createSignal<string | null>(null);
  /** When set, the Transcript tab shows this subagent file's transcript instead. */
  const [subFile, setSubFile] = createSignal<string | null>(null);

  const transcriptFile = () => subFile() ?? file();

  const [mainStats] = createResource(
    () => `${file()}\u0000${props.syncTick()}`,
    (key) => api.stats(key.split("\u0000")[0]!),
  );
  const [subStats] = createResource(
    () => (subFile() ? `${subFile()}\u0000${props.syncTick()}` : null),
    (key) => (key ? api.stats(key.split("\u0000")[0]!) : null),
  );

  const mainStatsSafe = () => (mainStats.error ? undefined : mainStats());
  const subStatsSafe = () => (subStats.error ? undefined : subStats());

  const toolsForTranscript = () => {
    const st = subFile() ? subStatsSafe() : mainStatsSafe();
    return st ? st.tools.map((t) => t.name) : [];
  };

  // Tiny peek at the session header entry for cwd / id (not in the stats payload).
  const [head] = createResource(file, async (f) => {
    try {
      const page = await api.transcript(f, null, 3);
      const se = page.entries.find((x) => x.type === "session");
      return {
        cwd: typeof se?.cwd === "string" ? se.cwd : null,
        id: typeof se?.id === "string" ? se.id : null,
      };
    } catch {
      return { cwd: null, id: null };
    }
  });

  const headSafe = () => (head.error ? null : head());

  const openSubagent = (f: string) => {
    setSubFile(f);
    setTab("transcript");
  };

  /** APG roving tabindex: arrow keys / Home / End move focus without activating. */
  const tabRefs: HTMLButtonElement[] = [];
  const onTabKeyDown = (e: KeyboardEvent) => {
    const current = tabRefs.indexOf(e.currentTarget as HTMLButtonElement);
    if (current === -1) return;
    let next: number | null = null;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (current + 1) % TABS.length;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (current - 1 + TABS.length) % TABS.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = TABS.length - 1;
    if (next === null) return;
    e.preventDefault();
    tabRefs[next]?.focus();
  };

  return (
    <div class="detail">
      <header class="detail-head">
        <div class="head-title-row">
          <h2>{mainStatsSafe()?.title ?? basename(file())}</h2>
          <span class="head-file">{file()}</span>
        </div>
        <div class="head-meta">
          <span class="kv">
            folder <b>{folderOf(file())}</b>
          </span>
          <Show when={headSafe()?.cwd}>
            <span class="kv">
              cwd <b title={headSafe()?.cwd ?? undefined}>{headSafe()?.cwd}</b>
            </span>
          </Show>
          <Show when={mainStatsSafe()?.spanMs != null}>
            <span class="kv">
              span <b>{formatMs(mainStatsSafe()?.spanMs)}</b>
            </span>
          </Show>
          <Show when={mainStatsSafe()?.user}>
            {(u) => (
              <span class="kv">
                user <b>{formatCompact(u().count)} msgs · {formatCompact(u().chars)} chars</b>
              </span>
            )}
          </Show>
          <Show when={mainStats.error}>
            <span class="kv err-kv">stats unavailable</span>
          </Show>
        </div>
        <nav class="tabs" role="tablist" aria-label="Session views">
          {TABS.map((t, i) => (
            <button
              type="button"
              role="tab"
              id={`tab-${t.id}`}
              aria-selected={tab() === t.id}
              aria-controls={`tab-panel-${t.id}`}
              tabIndex={tab() === t.id ? 0 : -1}
              ref={(el) => (tabRefs[i] = el)}
              classList={{ tab: true, active: tab() === t.id }}
              onClick={() => setTab(t.id)}
              onKeyDown={onTabKeyDown}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </header>

      <section
        classList={{ "tab-pane": true, hidden: tab() !== "analytics" }}
        role="tabpanel"
        id="tab-panel-analytics"
        aria-labelledby="tab-analytics"
      >
        <AnalyticsView
          stats={() => mainStatsSafe()}
          error={() => mainStats.error}
          onPickTool={(name) => {
            setToolFilter(name);
            setTab("transcript");
          }}
          onSynced={props.onSynced}
        />
      </section>

      <section
        classList={{ "tab-pane": true, hidden: tab() !== "transcript" }}
        role="tabpanel"
        id="tab-panel-transcript"
        aria-labelledby="tab-transcript"
      >
        <TranscriptView
          file={transcriptFile()}
          isSub={subFile() !== null}
          onBackToMain={() => setSubFile(null)}
          tools={toolsForTranscript}
          toolFilter={toolFilter()}
          onToolFilter={setToolFilter}
        />
      </section>

      <section
        classList={{ "tab-pane": true, hidden: tab() !== "subagents" }}
        role="tabpanel"
        id="tab-panel-subagents"
        aria-labelledby="tab-subagents"
      >
        <SubagentsView file={file()} onOpen={openSubagent} />
      </section>
    </div>
  );
}
