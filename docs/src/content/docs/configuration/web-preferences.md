---
title: Web interface preferences
description: Theme, font size, notifications, sidebar and view toggles, and prompt history live in the browser, separate from session and fleet state.
---

Some settings belong to the browser window, not to a session or the fleet: how the interface looks, what it notifies you about, which panels are open, and the prompt history you recall. These preferences are stored in the browser's local storage for the site origin. They survive reloads, omp-web updates, and fleet restarts, but they do not travel with a session, do not sync between browsers or devices, and are not part of the fleet's state file.

Most of them are edited under Settings > Web UI > Interface. A few are toggled by their own controls in the interface.

## Stored preferences

| Preference | What it changes | Default |
| --- | --- | --- |
| Theme preference | The palette: `system`, `dark`, `light`, `catppuccin mocha`, `catppuccin latte`, `omp dark`, or `omp light`. With `system`, the interface follows the operating system and switches live when the system theme changes. | `system` |
| Font size | The root font size, from 12 to 18 pixels in steps of one, scaling the whole interface. | 15 |
| Desktop notifications | Whether the browser raises desktop notifications for completed turns and error notices while the tab is hidden. | off |
| Usage in sidebar | The provider usage panel above the roster footer. The data is a one-shot refresh, never polled, so repeated opens are cheap. See [Provider usage limits](/analysis/provider-usage/). | off |
| Sidebar visibility | Whether the fleet sidebar column is open. First run on a narrow viewport (720px or less) starts closed because the sidebar is an overlay there; otherwise it starts open. | viewport dependent |
| Analysis sidebar visibility | Whether the transcripts sidebar is open in the Analysis view. | open |
| Work or Analysis view | Which top-level view the fleet UI restores on load. | Work |
| Collapsed roster groups | Which project groups and fallback repository headers are collapsed. Groups otherwise start open. | all open |
| Prompt history | The prompt history ring used by composer recall and history search. | empty |

Prompt history keeps the last 100 prompts, oldest to newest. Consecutive duplicates collapse into one entry, and the ring drops the oldest entry when it overflows. Every prompt sent from this browser is added, across sessions and across session daemons, so recall offers prompts from other conversations too. Browsing with the up and down arrows stashes the draft you were typing and restores it when you come back. The history is browser-local: another browser sees its own history, and nothing about it is stored in the session transcript. The [keyboard shortcuts reference](/reference/keyboard-shortcuts/) lists the recall and search keys, and [Prompting the agent](/sessions/prompting/) covers composing in general.

The storage keys are stable and safe to inspect or remove when cleaning a browser profile:

| Key | Preference |
| --- | --- |
| `omp-web:theme` | Theme preference |
| `omp-web:font-size` | Font size |
| `omp.notifyEnabled` | Desktop notifications |
| `omp.sidebarUsage` | Usage in sidebar |
| `omp.sidebarVisible` | Sidebar visibility |
| `omp.txSidebarVisible` | Analysis sidebar visibility |
| `omp.view` | Work or Analysis view |
| `omp.sidebarGroupsCollapsed` | Collapsed roster groups |
| `omp-web:history` | Prompt history |

## Session display toggles that are not persisted

Two display toggles in the same section control how streamed output is presented. They live in the browser session only and reset to their defaults on every reload:

- **Reveal queue** (on by default): paces streamed text so output reveals gradually instead of appearing in bursts.
- **Soft fade** (off by default): fades the newest output as it arrives.

Because they are not persisted, a reload returns reveal to on and soft fade to off, and they are never sent to the session daemon.

## Session-scoped controls in the same section

Three rows appear in Web UI only while a session is attached, and they act on the live session rather than the browser:

- **Fast mode** and **auto-retry** command the running session daemon. They reset when the session daemon process ends, so a resumed session starts with the defaults again.
- **Login providers…** opens provider authentication, which is explained in [Models and provider authentication](/configuration/models-and-auth/).

With no session attached, these rows are hidden, because there is no live process to command. The same section shows the Images group, but those items are schema-backed agent settings that persist to `config.yml`, not browser preferences. See [Settings overview](/configuration/settings/).

## Persistence and reset behavior

- Preferences are keyed by the site origin. Opening the same fleet on a different port or hostname is a different origin and starts from defaults.
- Clearing site data for the origin resets every preference in the tables above, including prompt history.
- Corrupt or out-of-range values fall back to defaults rather than breaking the interface: an unrecognized theme resolves to `system`, a font size outside 12 to 18 resolves to 15, a malformed collapsed-groups list opens all groups, and unparsable prompt history starts empty.
- Prompt history writes are best-effort. If storage is full or unavailable, the history stops recording; nothing else fails.
- Desktop notifications require permission. Enabling the toggle asks for it on first use. If permission is denied, turns complete silently, with no error; the toggle still reflects your stored preference, and the browser's site settings are where you change permission.

## Related

- [Settings overview](/configuration/settings/)
- [The fleet sidebar](/fleet/sidebar/)
- [Prompting the agent](/sessions/prompting/)
- [Keyboard shortcuts](/reference/keyboard-shortcuts/)
- [Data and state management](/configuration/data-and-state/)
