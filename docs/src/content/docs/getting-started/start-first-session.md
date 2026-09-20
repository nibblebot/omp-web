---
title: Start your first session
description: Start the main-checkout session daemon for a registered project, choose a new or previous session, send your first prompt, and resume after the session daemon sleeps.
---

This page assumes the project is already registered. See [Add your first project](/getting-started/add-first-project/) if the sidebar is still empty, and [First run](/getting-started/first-run/) if `omp` may not have a provider and a default model yet. For the underlying model, see [Projects, worktrees, session daemons, and sessions](/concepts/projects-worktrees-session-daemons-sessions/).

## Start the main-checkout session daemon

A registered project appears as a sidebar group with a row for its main checkout. If `Start a session now` was off during registration, that row starts asleep and persists while no session daemon process is running.

1. Find the project group in the fleet sidebar.
2. Click the asleep main-checkout row. omp-web starts its session daemon and queues the browser attachment.
3. Watch the row move through spawning, connecting, session created, and resolving provider and model. The row shows a waking state until attachment finishes.
4. When the row reaches ready, the browser attaches automatically and marks it as the active session.

If `Start a session now` was enabled while adding the project, omp-web already ran register, spawn, and attach for you.

The composer stays gated until the attached session daemon reports ready. Readiness is reported by the session daemon after it resolves its provider, model, and authentication; an open connection alone is not readiness. While gated, Enter is suppressed, the send button is disabled, and a pill near the buttons says that the session is still starting. Wait for ready instead of resending the prompt.

## Choose a new session or resume a previous one

- Onboarding picker: when the session daemon was started through the add-project or add-worktree flow with `Start a session now` enabled, the first attach also checks that worktree for existing transcripts. If any exist, the History modal opens headed `New session or resume`, newest first, with a `New session` row at the top that starts fresh with no history. Escape in that modal also chooses `New session`. If no transcripts exist, omp-web starts a fresh session immediately and no modal appears. This picker appears only for that onboarding flow.
- Explicit resume: run `/resume` at any time to open the same modal headed `Resume from disk`. The list is filterable by name or working directory, and each row shows the session's directory, message count, and timestamp. Selecting a row makes that transcript the live session.
- Wake path: clicking an asleep row resumes its last transcript without opening a picker, which is described below.

## Send your first prompt

With a ready row attached and a fresh transcript, the main pane greets you with the provider's character and begins, `<name> is ready. What should we work on?`. Suggested-prompt chips such as `Summarize this repo` insert text into the composer; they do not send a message.

Composer behavior:

- Enter sends the message when the agent is idle and steers the running turn when the agent is streaming. The primary button label follows: Send or Steer.
- Ctrl+Enter or Cmd+Enter submits a follow-up instead of a steer.
- Shift+Enter inserts a newline.
- Escape aborts the running turn, like the Stop button.

Queue shorthand, for lining up work while the agent is busy:

- `-> message` queues a steer while the agent is streaming; on an idle session it sends an immediate prompt instead.
- `=> message` always queues a follow-up.
- `/queue message` also queues a follow-up.
- Queued items appear as chips above the composer. Alt+Up pulls the last queued message back into the composer, and `clear all` drains the queue.

Typing `/` opens slash-command completion and `@` mentions files; Tab applies the highlighted completion. Slash commands that omp-web does not handle are sent to the agent, so agent builtins, skills, and extensions still work. See [Prompting the agent](/sessions/prompting/) for the full prompting workflow.

The strip above the composer shows the session's provider and model, thinking level, context usage, and cost so far.

## Track which session is loaded

- The row card: clicking a ready row attaches this browser to that session daemon and shows its current session. The attached row is highlighted.
- The session title line: rows show the last transcript's title, or `New session` for a fresh untitled transcript. Click that line rather than the rest of the card to open a dropdown of that worktree's last ten sessions, newest first, with relative times, and the loaded transcript highlighted. Choosing an entry resumes it: a ready row switches the live session, an asleep row wakes with that transcript.
- The `New session` button: the button next to Send starts a fresh session, asking for confirmation first when the current transcript is not empty.

## Return after the session daemon sleeps

A session daemon is disposable; the transcript is durable.

- What asleep means: there is no live session daemon process. The fleet keeps the worktree path and last transcript so the session daemon can be resumed later.
- How a row goes asleep: use `Stop daemon` and then `Confirm stop` in the row's menu, or let the session daemon reach its idle auto-exit. The default idle timeout is 30 minutes of continuous inactivity. While at least one browser has the fleet open, ready session daemons are kept alive so their activity stays visible; their idle timers resume when the last browser disconnects.
- What you see: when the attached session daemon is stopped or goes asleep, the chat column is replaced by the `No active session` pane, and the row stays in the sidebar.
- Wake and resume: click an asleep row's card. omp-web wakes the session daemon with its last transcript and attaches this browser once it is ready. The row shows a waking state until the attach settles. A session daemon that has no stored transcript starts a fresh session instead.
- Resume a specific transcript: click the asleep row's session title line and choose a session from the dropdown. That wakes the session daemon with the chosen transcript and attaches this browser.
- Durable transcripts: the conversation is stored as a JSONL transcript on disk, not in the browser or the process, so closing the tab does not end it. The `/exit` notice says the session persists and that closing the browser tab is how you leave. Resuming reopens the transcript with its history intact, and the session appears again in the resume lists.

## If the first session does not start

- No provider or no default model: prompts fail until a model resolves. Run `omp`, open its `/settings`, and configure a provider and the default model, or run `omp login` for an OAuth provider. Restart or wake the session daemon afterward. The first-run check prints `providers: none configured` and `default model: none` in this state; see [First run](/getting-started/first-run/).
- A row that never leaves resolving provider and model: provider or model resolution did not finish, usually because of missing authentication. Fix the setup above, then stop and wake the row, or open `Daemon details` from the row's menu to inspect it.
- `No active session` with no visible row: the attached session daemon was removed. Pick another row, or use the project action labeled `Start a session in <project>` to spawn one.
- Transcript is locked: if a session daemon exits with `omp-session: session file <file> is locked by another omp-session (pid <pid>)`, another session daemon already owns that transcript. Stop that process or resume a different session; do not delete the lock file.
- Reconnecting or protocol errors: a dropped transport usually recovers on its own, but a protocol mismatch means the browser and the session daemon come from incompatible builds and will not reconnect. See [Troubleshooting](/operations/troubleshooting/) for the full symptom list.

Where to go next: [Interface tour](/getting-started/interface-tour/) names the surfaces around the sidebar and transcript, and [The fleet sidebar](/fleet/sidebar/) explains the roster in detail.
