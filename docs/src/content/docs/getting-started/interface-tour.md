---
title: Interface tour
description: Walk through the omp-web Work and Analysis views, the fleet sidebar, transcript, composer, queue, model strip, settings, and Debug panel.
---

omp-web puts one live agent conversation at the center, with the fleet roster at
your left. This tour names each surface so the detailed pages make sense. It
assumes a running `omp-web` with at least one project; see
[Add your first project](/getting-started/add-first-project/) and
[Start your first session](/getting-started/start-first-session/) first if you
have not set those up. For the process model behind the interface, see
[Projects, worktrees, session daemons, and sessions](/concepts/projects-worktrees-session-daemons-sessions/).

## Work and Analysis

Two icon buttons at the top of each sidebar switch the top-level view:

- **Work** is the live workspace: fleet sidebar, transcript, composer.
- **Analysis** browses historical transcripts, fleet-stored session history, session analytics, and subagent transcripts.

Analysis reads the fleet statistics API, so it is served by the fleet itself.
Each view remembers its own sidebar state, and a turn that finishes while you
are in Analysis lights a small dot on the Work button until you return.

When no session daemon is attached, the chat column is replaced
by a short message that points you at the sidebar. Attach a session daemon and
the full surface below appears.

## Fleet sidebar

The sidebar is the project-first roster of session daemons.
[The fleet sidebar](/fleet/sidebar/) documents it in depth. The main pieces:

- A **Projects** heading with a **+** button that opens the add-repo flow.
- One collapsible group per registered project: the main-checkout row first,
  then worktree and clone workspace rows, ending with **+ Add workspace** (a
  worktree, a clone workspace, or an existing worktree to adopt).
- Rows can show the session daemon name and session title, labels, working
  directory, branch, and git change counts. Clone workspace rows carry a `clone`
  chip and their provider profile id. The left dot shows lifecycle states
  from spawning through ready, asleep, reconnecting, or error. On ready rows it
  can instead show in progress, blocked, unread, or unreviewed activity.
- Clicking a ready row attaches to that session daemon; clicking an asleep row
  wakes it and resumes its last session. Clicking the session title instead
  opens the recent-sessions menu for that checkout.
- The row actions menu offers **Stop daemon**, **Remove daemon**,
  **Daemon details**, and, on worktree rows, **Delete worktree…**. On clone
  workspace rows it instead offers **Start workspace**, **Stop workspace**,
  **Stop current work** on the attached row, and **Delete workspace…**; see
  [Clone workspaces](/fleet/clone-workspaces/).
- The footer holds **Debug** and **Settings**, plus an optional Usage panel.
- When the fleet is configured with browser auth, a browser without a session
  gets the **Sign in** dialog before the roster loads, and sign out lives in
  Settings under Web UI; see [Browser access and sign-in](/operations/browser-auth/).

## Transcript

The transcript fills the main column:

- The editable session title sits above the stream. Click it, type, and press
  Enter to rename; unnamed sessions fall back to the first characters of the
  session id.
- Tool calls appear as cards. The stream toolbar switches between
  **expanded**, **collapsed**, and **consolidated** tool views, while
  **expand** (or Ctrl+O) opens or closes every tool output at once.
  Consolidated mode folds consecutive tool runs into a single summary row.
  File edits render as inline diffs, and tool output can include images.
- While the agent streams, a shimmering line shows the current working intent,
  and a **Jump to bottom** button appears if you scroll away from the live
  edge.
- An empty transcript greets you with suggested prompts that insert into the
  composer without sending.

## Composer and queue

Between the transcript and the composer sit queued messages, live activity
strips, and the model strip.

The composer is the text area at the bottom:

- Enter sends. While the agent is streaming, Enter steers the running turn and
  the send button reads **Steer**; Ctrl+Enter or Cmd+Enter always queues a
  follow-up, and Shift+Enter inserts a newline.
- Type `/` for commands and `@` for file paths; Tab completes.
- Paste an image to attach it to the next message; each thumbnail has a
  **Remove image** button.
- Escape aborts the running turn. With an empty composer, pressing Escape
  twice opens the branch picker.
- `-> message` steers while streaming and sends normally while idle;
  `=> message` always queues a follow-up.

Queued messages appear as **steer** and **follow-up** chips above the
composer, and the status bar counts them as `queued: N`. A chip's x button, or
Alt+Up, pops the newest queued message back into the composer; **clear all**
empties the queue.

[Prompting the agent](/sessions/prompting/) covers the composer,
autocomplete, history, and queue behavior in full.

## Model, thinking, and context strip

Directly above the composer:

- **Model** shows `provider/model`, or **no model** when none is resolved.
  Click it to open Model roles.
- **Thinking** shows the current level, or **inherit**. Click to cycle,
  right-click to pick.
- **Context** shows `ctx N%`, with a tooltip for used and total tokens.
- **Cost** shows cumulative dollars plus input and output token counts. Click
  it for Session stats.

## Status bar, settings, and Debug

The top status bar shows live turn state: compaction, goal, plan mode, auto
retry, the queue count, subagents, a disconnected pill, and a dismissible
error banner. Goal, plan, and subagents are clickable.

**Settings** opens as a full-height sheet from the sidebar footer in Work, or
from the status bar wherever the roster sidebar is absent (the Analysis view).
It has a search field, a Web UI section for browser
preferences such as theme, font size, notifications, and sidebar usage, plus
provider and schema-backed agent settings. With no session attached, the
sheet notes that changes save to `config.yml` and apply to new sessions.

**Debug** is the transport and fleet diagnostics panel: connection state,
client and session ids, last frame and reconnect timing, fleet paths, a
session daemon table, the fleet log, and recent client transport events. It
polls on its own and has a manual refresh. It is the first place to look, or
to collect from, when reporting a problem:
[Troubleshooting](/operations/troubleshooting/).

## Tool and subagent areas

- Tool cards expand to full output, and the three stream views control the
  default detail. Renderers cover common tools, and anything else falls back
  to a generic card.
- While subagents run, a strip above the composer lists each active one;
  clicking a row opens the subagents panel. The status bar shows
  `subagents (N)` as well.
- Supervised background processes appear in the same strip with their state,
  ready port, pid, uptime, and **restart** and **kill** buttons.
- In Analysis, the **Subagents** tab lists historical subagent transcripts for
  the selected session and opens any of them in the transcript viewer.

## Desktop and narrow layouts

On a desktop-width viewport the sidebar is a docked column. Each view
remembers whether its sidebar is open, and Work and Analysis collapse
independently. When the current sidebar is closed, a floating button at the
top left of the viewport reopens it (**Open roster sidebar** or **Open
transcripts sidebar**), and the open sidebar carries its own **Close sidebar**
button.

On a narrow viewport the sidebar slides over the content instead. Tapping the
dimmed area outside it closes it, and the first load on a narrow viewport
starts with the roster sidebar closed so the conversation has room.

## Where to go next

- [Start your first session](/getting-started/start-first-session/)
- [Prompting the agent](/sessions/prompting/)
- [The fleet sidebar](/fleet/sidebar/)
- [Clone workspaces](/fleet/clone-workspaces/)
- [Troubleshooting](/operations/troubleshooting/)
