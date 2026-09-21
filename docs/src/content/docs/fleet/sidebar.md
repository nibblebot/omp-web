---
title: The fleet sidebar
description: "Read the fleet roster at a glance: project groups, main-checkout and worktree rows, status and activity dots, and what clicking each row or menu does."
---

The fleet sidebar is the left column of the Work view, served by the fleet. It lists every registered project together with the session daemons running for it, including clone workspace rows, and it is where you attach to a session, wake a sleeping session daemon, or open a project or row action menu. For the underlying model, see [Projects, worktrees, session daemons, and sessions](/concepts/projects-worktrees-session-daemons-sessions/).

The column opens with the Work/Analysis mode switch and a close button, followed by a Projects header whose + button opens the Add repo modal described in [Add your first project](/getting-started/add-first-project/). The roster list sits below that header, then the optional usage panel and the Debug panel and Settings footer. While the column is closed, a button in the top-left corner of the viewport reopens it.

## Project grouping

Each registered project renders as its own collapsible group, in registration order. A project stays in the list even when it has no session daemons yet.

- The group header shows a caret and the project name. The full checkout path is available from the header tooltip.
- Hovering or focusing the header reveals a project actions menu, labeled with the project name, that contains **Delete project…**. Deleting a project only deregisters it; repository files are never touched.
- While a project has no main-checkout row in any status, the header also offers a start action, labeled **Start a session in &lt;project&gt;**, which spawns the project's main-checkout session daemon. See [Start your first session](/getting-started/start-first-session/).
- An expanded group ends with a **+ Add workspace** action, which opens the **Add workspace** modal: a managed worktree of the project, an independent clone workspace, or an existing worktree to adopt. See [Create and adopt worktrees](/fleet/worktrees/) and [Clone workspaces](/fleet/clone-workspaces/).
- Roster entries that have no registered-project association, including remote and unregistered entries, fall into one trailing set. That set is grouped by repository name, sorted alphabetically, and repos that contain worktrees get their own collapsible headers.

When nothing is registered yet, the roster area is replaced by a first-run panel whose primary action is **Add your first project**. After the fleet has data, an empty roster instead shows a short hint pointing at the Projects header + button.

## Main-checkout, worktree, and clone rows

Rows adapt to where they sit:

- **Main-checkout rows** are the untagged entries inside a project group. The row shows a root glyph and uses the current branch as its title, falling back to the entry name when no branch is known. The project chip and the working-directory line are dropped because the group header already names the project; the path is in the row tooltip and in **Daemon details**.
- **Worktree rows** are nested under their project group and also use the branch, or the entry name, as the title. They never show the directory.
- **Clone workspace rows** sit inside their project group as well, but they are not worktrees and never render as root rows. They keep the fuller profile: the workspace name as the title, a `clone` chip plus the provider profile id chip, the project and label chips, and the working-directory line.
- **Fallback rows** outside a project group keep the fuller profile: entry name as the title, plus project and label chips and the working-directory line.

Every row can also carry a line with the title of the session daemon's last session. An empty or new session renders as **New session** instead. The line truncates, and its tooltip exposes the full title.

## Branch and diffstat

Full-profile rows show the current branch on their own line. Main-checkout and worktree rows already show the branch as the title.

The diffstat cluster reports uncommitted work when the fleet has probed it:

- a file glyph with the number of changed files,
- `+N` for lines added,
- `-N` for lines deleted.

The counts come from Git status and diff data for the checkout. They are absent for remote entries and for checkouts the fleet could not probe, and a clean checkout renders no cluster at all. On a roster row, these chips are deliberately separate from the status and activity dots described below.

## Status ladder

The dot at the left of each row shows the session daemon's lifecycle status. Rows in a transitional state, in reconnecting, and in error are not clickable; ready and asleep rows are.

| Status | What it means | Dot |
| --- | --- | --- |
| spawning | The session daemon process is starting. | Blue, pulsing |
| connecting | The fleet is opening its connection to the session daemon. | Blue, pulsing |
| session | The session daemon created or restored the session. | Blue, pulsing |
| resolving | Provider, model, and authentication are resolving. | Blue, pulsing |
| ready | The session daemon accepts prompts. | Green |
| reconnecting | The stream dropped and the fleet is redialing. | Amber |
| asleep | No live session daemon process; the session can be resumed. | Grey |
| error | The row has terminal failure details. | Red |

Hovering a row gives the status in words, and the attached row is labeled as the active session. Transitional rows are not clickable while they settle.

A clone workspace row adds a second line while its provider work runs: preparing workspace, starting runtime, connecting channel. A failed stage shows the lifecycle error text and a **Retry** button that re-issues the start; `ready` renders nothing extra, because the status dot already says it. See [Clone workspaces](/fleet/clone-workspaces/).

## Activity dots

A ready row can repaint its dot with live session activity. Only the four states below render an activity dot; an idle row keeps the plain status dot. Precedence for the attached session is blocked, then in progress, then unreviewed; for a detached row it is blocked, then in progress, then unread.

| Activity | When it shows | Dot |
| --- | --- | --- |
| in progress | A turn is streaming, either on the attached session or reported by the fleet for a detached session daemon. | Spinning green |
| blocked | A dialog from an extension is waiting for your input. | Red |
| unreviewed | The attached session finished a turn while you were scrolled away from the live edge. | Yellow |
| unread | A detached session finished a turn while you were viewing another session. | Blue |

Unreviewed clears when you scroll back to the live edge, send a prompt, or switch sessions. Unread clears when you attach to that session daemon. Git dirtiness never feeds these dots; uncommitted changes appear only as the diffstat chips above.

## Clicking a row

A row has two click targets, and they do different things.

- **The card** (anywhere except the session title line) resumes the session daemon's current session. A ready row attaches; if it is already the attached row, the click does nothing. An asleep row wakes and then attaches: a local row respawns, a clone row re-provisions its compute first. While a wake is in flight the row is highlighted and shows a waking pulse until the attach settles.
- **The session title line** opens the last-ten-sessions dropdown for that checkout. The dropdown lists up to ten sessions, newest first, with the session name or a short id and a relative time, and highlights the file of the current session. It can show a loading note, an error, or a note that there are no sessions yet. The line only exists when the session daemon has a session title or an empty new session, and it is only clickable on ready and asleep rows.

For a clone row the dropdown answers from the fleet log store instead of disk, so it works whether or not the clone is running. Store entries carry no titles, so names fall back to a timestamp label such as `Untitled · 14:32`.

Selecting an entry in the dropdown resumes that exact session file. On an asleep row the session daemon wakes with that file instead of its last one. The dropdown is fetched on demand, so it works for a session daemon that has never started in this browser session. Clicking outside the row or pressing Escape dismisses it.

The two popups never stack: opening the row actions menu closes the session dropdown, and opening the dropdown closes the menu.

## Project and row menus

The **Stop daemon** and **Remove daemon** row actions use a two-click confirmation. The first click arms the item and keeps the menu open; the second click runs the action and closes the menu.

- **Row actions**, the ⋯ menu revealed on hover or focus (always visible on touch), contains **Stop daemon** followed by **Confirm stop**, **Remove daemon** followed by **Confirm remove**, and **Daemon details**. Stop is hidden on asleep rows because there is no live process to stop. Remove drops the row from the roster and stops the session daemon first. Worktree rows additionally offer **Delete worktree…**, which opens the guarded deletion dialog.
- **Clone workspace rows** replace part of that menu, because a clone is provider-managed compute: an asleep clone offers **Start workspace**; any clone row that is not asleep offers **Stop workspace** followed by **Confirm stop**; the attached clone additionally offers **Stop current work**, which interrupts the running turn without stopping the workspace; and the destructive item is **Delete workspace…**, which opens the verified-deletion dialog described in [Clone workspaces](/fleet/clone-workspaces/). Clones have no **Remove daemon** item, so a clone row can never be evicted from the roster without passing the deletion gate.
- **Project actions**, revealed on the project group header, contains **Delete project…**. This opens a **Remove project** confirmation dialog, which names any session daemons that must be removed before the project can be deregistered.

## Sleeping and waking

Asleep means the session daemon has no live process, but its checkout and last session file are preserved. Clicking the card wakes it with the last session file and attaches; picking a session from the dropdown wakes it with that file. A wake never opens the history picker, it resumes silently. A remote session daemon that is asleep is woken by redialing instead of respawning. A clone workspace row wakes through its provider lifecycle: the fleet re-provisions compute, resumes the last session, and materializes the transcript from the fleet store first when the volume is cold. Stopping a clone keeps its checkout and session logs; only the verified delete removes them.

Remote and unregistered rows share the fallback grouping, but their available details can differ. Remote rows have no fleet-probed Git facts or session title, so they show no diffstat and no session dropdown. Unregistered local rows can still show those details when the fleet can probe their checkout. Both kinds can be attached or woken like any other row.

## Browser auth

When the fleet is configured with browser auth (`browserAccessToken`), the browser side of the fleet is gated. A browser that has no session gets the **Sign in** dialog on load: paste the operator access token. The token is posted once, exchanged for an HTTP-only session cookie, and never stored in the browser; sessions last 30 days and are revoked wholesale when the access token is rotated. Once signed in, the Settings panel's Web UI section carries a **Session** group with a **sign out** action.

Loopback peers are exempt from the gate, so a default local fleet needs no sign-in at all. With a token configured on a loopback bind the dialog still appears on first load, because the page derives its signed-in state from the session probe; you can sign in or close it and keep working locally. A non-loopback fleet bind without browser auth configured is a startup error. See [Browser access and sign-in](/operations/browser-auth/).

## Work and Analysis restriction

The fleet sidebar shows only while the Work view is active. The Analysis view brings its own transcripts sidebar, so the roster sidebar is not visible there.

## Collapse and persistence

Project groups and fallback repository headers collapse from their caret. Collapse state is stored in the browser, so a group you close stays closed after a reload. The sidebar's own open or closed state and the selected Work or Analysis view are also remembered per browser. These are browser preferences, not fleet state; another browser or device starts from its own defaults.

## Related

- [Projects, worktrees, session daemons, and sessions](/concepts/projects-worktrees-session-daemons-sessions/)
- [Interface tour](/getting-started/interface-tour/)
- [Add your first project](/getting-started/add-first-project/)
- [Create and adopt worktrees](/fleet/worktrees/)
- [Clone workspaces](/fleet/clone-workspaces/)
- [Browser access and sign-in](/operations/browser-auth/)
- [Start your first session](/getting-started/start-first-session/)
- [Troubleshooting](/operations/troubleshooting/)
