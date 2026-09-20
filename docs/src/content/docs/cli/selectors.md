---
title: Select multiple session daemons
description: "How the fleet resolves a session daemon selector into roster entries: exact ids, all, label and project filters, and anchored name globs."
---

Three fleet verbs take one selector and act on every session daemon it matches: `stop`, `remove`, and `prompt`. The fleet resolves the selector against the live roster each time a command runs, so an entry registered a moment ago is selectable, and a session daemon id is never reused. For the commands themselves, see [Operate session daemons](/cli/session-daemon-operations/) and [Fan-out prompting](/cli/fanout/).

## Resolution order

The fleet tries the forms below in order and stops at the first one that applies. Except for `all`, every form matches against roster fields, not against the directory listing.

| Form | Matches | Notes |
| --- | --- | --- |
| `all` | Every roster entry | Includes asleep and error rows |
| An exact session daemon id, such as `d3` | The one entry with that id | Wins over every other interpretation, so a name can never shadow an id |
| `label:k=v` or `tag:k=v` | Entries whose labels contain exactly `k=v` | The `tag:` spelling is an alias; an entry with several labels matches when any label equals `k=v` |
| `project:name` | Entries whose project field equals `name` exactly | The field defaults to the checkout directory basename; the main checkout's basename is the project name, and a managed worktree's is the worktree directory name |
| Anything else | Entries whose name matches the value as a glob | This is the fallback, and it can be the empty set |

Matching is case-sensitive for every form. A label is compared as one whole string, so `role=api` does not match a label `role=api-v2`, and a project named `App` does not match `project:app`.

## Name globs

The fallback form is an anchored glob against the entry name, the display name shown in the `name` column of `omp-web sessions`:

- `*` matches any run of characters, including none.
- `?` matches exactly one character.
- Every other character is literal, including regular expression specials such as `.`, `+`, and `$`.
- The pattern is anchored at both ends, so `alpha` matches only a name that is exactly `alpha`, and `alpha*` matches names that start with it.

The most common mistake is reading a glob as a prefix over session daemon ids. A selector such as `d*` is a literal name pattern, so it matches entries whose name starts with the letter `d`, not every session daemon. Use `all` to address the whole roster.

## Worked example

Given this roster:

| id | name | project | labels |
| --- | --- | --- | --- |
| `d1` | `alpha` | `app` | `role=api` |
| `d2` | `alpha-2` | `app` | `role=web` |
| `d3` | `beta` | `other` | none |

| Selector | Match | Why |
| --- | --- | --- |
| `d1` | `d1` | Exact id |
| `all` | `d1`, `d2`, `d3` | Every entry |
| `label:role=api` | `d1` | Label equality |
| `tag:role=web` | `d2` | Alias for `label:` |
| `project:app` | `d1`, `d2` | Project field equality |
| `alpha` | `d1` | Exact name |
| `alpha*` | `d1`, `d2` | Name glob |
| `alph?` | `d1` | `?` is one character |
| `*a*` | `d1`, `d2`, `d3` | Every name contains an `a` |
| `d*` | None | Matches names, not ids |

You can confirm a match before acting on it: `omp-web sessions` prints the ids, names, projects, and labels, and a selector that matches nothing is refused rather than ignored.

## Empty matches are errors

For `stop`, `remove`, and `prompt`, a selector that matches nothing fails the command with exit 1 and a message naming the selector. Nothing is stopped, removed, or prompted. That is deliberate: a typo in a bulk `stop` should not look like success.

Inside the fleet, the same rule applies to the control plane, which is why a scripted command either reports exactly which session daemons it acted on or fails.

## What selectors do not cover

- There is no listing command that accepts a selector; `omp-web sessions` lists the whole roster, and `omp-web projects` lists the discovered worktrees that are not roster rows yet.
- `rm-worktree` takes exactly one session daemon id and no selector form, because deleting a directory is a single-target operation.
- `rm-project` and the `<project>` argument of `add-worktree` take their own project selector, resolved client-side against the registered projects: project id, exact path, or name. See [Manage projects and worktrees](/cli/projects-and-worktrees/).
- Selectors cannot express negation, intersections, or unions. To address an arbitrary set, run the command once per selector.

## Related

- [CLI overview](/cli/overview/)
- [Operate session daemons from the CLI](/cli/session-daemon-operations/)
- [Fan-out prompting](/cli/fanout/)
- [Understand roster status](/fleet/roster-status/)
- [CLI commands and flags](/reference/cli/)
