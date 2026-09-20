---
title: Design
description: How the omp-web interface is designed, where its UI tokens live, and which documents contributors should treat as authoritative.
---

omp-web is a mission-control console for one operator supervising many agent sessions. Its design is documented in the repository, and this page is the contributor map to that material.

| Topic | Authoritative source |
| --- | --- |
| Product audience, positioning, capabilities, and constraints | [PRODUCT.md](https://github.com/nibblebot/omp-web/blob/main/PRODUCT.md) |
| Design intent, principles, named rules, and component vocabulary | [DESIGN.md](https://github.com/nibblebot/omp-web/blob/main/DESIGN.md) |
| Shipped token values and theme palettes | [`src/styles/tokens.css`](https://github.com/nibblebot/omp-web/blob/main/src/styles/tokens.css) |
| Exact values, theme slot inventory, and reference HTML/CSS recipes | [`.impeccable/design.json`](https://github.com/nibblebot/omp-web/blob/main/.impeccable/design.json) |

Where this page and a canonical source disagree, the canonical source wins.

## Who the interface is for

omp-web targets a solo operator running parallel agents: one developer spawning, supervising, and steering many concurrent sessions across local projects, Git worktrees, and remote sandboxes. Every surface optimizes for supervising N sessions rather than one conversation. The [session model](/concepts/projects-worktrees-session-daemons-sessions/) explains the concepts the UI is built around.

Current product constraints bound what the interface may assume. These are limits, not backlog promises:

- Multi-user access is not implemented. It is an open strategic question in PRODUCT.md, not a current audience.
- There is no browser collaboration surface. Collaboration rooms are operated through the CLI or TUI.
- Browser fan-out prompting is not implemented. Fan-out is a CLI capability.
- Analysis views need the fleet's statistics service, which every deployment now has.
- Remote access is user-managed, for example over SSH forwarding or a private network. Remote TLS management is not part of the product.

A design direction that only makes sense once one of these exists is out of scope until PRODUCT.md says otherwise.

## Design principles

The design direction is "The Mission Control Console": one operator, many agents. The screen's job is supervision, not conversation, so surfaces recede and status carries the signal. Density follows the terminal rather than the chat app.

The named rules are the system's load-bearing constraints. Read their full statements in DESIGN.md.

- **One Voice:** the accent appears on at most 10% of any screen, on focus rings, the active selection, and one primary action.
- **Semantic Trio:** a status is never a bare color; every status surface ships background, border, and text from the same semantic trio.
- **Flat by default:** resting surfaces carry no shadow; structure comes from 1px hairlines and tonal panel steps, and shadow means an overlay or a status glow.
- **Hairline:** a boundary gets a 1px border, never shadow or whitespace alone.
- **Zero-Asset:** no webfonts; system sans and system mono stacks only.
- **Two-Voice:** sans is the operator speaking, mono is the machine reporting.
- **One motion vocabulary:** 140ms ease-out, with animated elements gated behind `prefers-reduced-motion`.

## Where UI tokens live

`src/styles/tokens.css` is the shipped source of truth. It defines the semantic color slots (surfaces, the text ladder, the accent, status trios, diff washes, and the data-viz ramp), the shared scales (radius, spacing, elevation, motion, focus ring, type, and z-order), and the `:root[data-theme="..."]` palettes for six themes: the default dark console plus light, catppuccin-mocha, catppuccin-latte, omp-dark, and omp-light. Themes override color slots only; radius, spacing, and type stay shared across all of them.

Theme and font size are client-local preferences. `index.html` resolves the stored theme before first paint, `src/prefs/theme.ts` applies it at runtime, and the root font size is user-settable from 12 to 18px. Every type step is rem-based so it rides that dial. Components consume tokens; they never hardcode color, radius, or spacing values.

### The canonical design schema

`.impeccable/design.json` is the machine-readable companion to DESIGN.md (schemaVersion 2). It records the narrative (north star, key characteristics, named rules, and do's and don'ts), the color slots with display names and tonal ramps, typography roles, shadows, motion, breakpoints, per-theme token values, and a components array of reference HTML and CSS recipes.

Use it when you need exact values, a theme slot inventory, or a reference recipe. Do not treat it as a second source of truth: DESIGN.md owns intent and rules, and `src/styles/tokens.css` owns shipped behavior. Changes to the system update all three together.

The same directory holds dated critique snapshots under `.impeccable/critique/`. Those snapshots record a review from a point in time and are not a current work list; remediation work has landed since. Verify any finding against the current code and the [changelog](https://github.com/nibblebot/omp-web/blob/main/CHANGELOG.md) before acting on it.

## Component and style conventions

- One global stylesheet split by domain under `src/styles/`: base, app, chat, tools, prompt, modals, settings, fleet, and usage, with the transcripts view bringing its own `src/tx/tx.css`. `src/styles.css` is the single `@import` entry and its order is load-bearing, so new rules go where the existing cascade stays intact.
- Plain kebab-case, feature-prefixed class names such as `msg-*`, `tool-*`, and `daemon-*`. No CSS modules and no utility framework.
- The component vocabulary comes from DESIGN.md: one primary button per view with quiet ghost and danger variants; pill chips and 8px status dots; one shared tool-card shell for every tool render; user messages in bubbles with assistant output edge-to-edge; a single global focus ring; centered modals and right-docked sheets; and the roster row as the signature component.
- UI components are presentational. They read the `src/state.ts` store reactively, mutate only through exported store actions, and express visual state through classes and DOM attributes such as `data-status`.
- Repository-wide engineering conventions for the UI, from the client state model to formatting and verification, live in [AGENTS.md](https://github.com/nibblebot/omp-web/blob/main/AGENTS.md).

## Accessibility and responsive expectations

- One global `:focus-visible` ring drawn from `--focus-ring`; search-style fields swap it for an accent border instead.
- Interactive controls carry a 24px minimum target for fine pointers, and touch controls grow to at least 32px (WCAG 2.5.8 AA). Hover-only actions such as message copy and row menus stay visible on touch.
- Motion uses the 140ms ease-out vocabulary and is disabled or simplified under `prefers-reduced-motion`.
- Type steps are rem-based and ride the user's root font size; nothing functional renders below the 9.6px micro floor.
- Status is never color alone: the roster status dot carries a `role="status"` and a label, and semantic surfaces use the full background, border, and text trio.
- The shell breakpoint is 720px, where the sidebar becomes a slide-out overlay with a scrim, sheets go full viewport, and settings swaps its nav rail for a section picker. The transcripts view adds a 480px breakpoint.

## Changing the system

1. Read DESIGN.md before changing visuals and PRODUCT.md before changing what a surface is for.
2. Build from existing tokens and the component vocabulary. If a value is missing, extend the shared scale instead of hardcoding a one-off.
3. When a token, theme, or scale rung changes, update `src/styles/tokens.css`, DESIGN.md, and `.impeccable/design.json` together.
4. Keep themes to color-only overrides.
5. Verify UI changes in the running app (`bun run dev`), including the 720px breakpoint and reduced-motion behavior.

The [project section overview](/project/) lists the other maintainer pages.
