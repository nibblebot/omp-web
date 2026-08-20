---
name: omp-web
description: Mission-control web UI for supervising parallel omp agent daemons
colors:
  bg: "#0f1115"
  bg-deep: "#0a0d12"
  panel: "#151a22"
  panel-2: "#1a2029"
  btn: "#232a37"
  border: "#262b36"
  border-strong: "#333c4d"
  text: "#d7dae0"
  muted: "#8b93a1"
  muted-2: "#7f8896"
  muted-3: "#aab2c0"
  hover: "#232f42"
  accent: "#7cc7ff"
  accent-dim: "#1f3a5f"
  accent-border: "#2d527f"
  success: "#4ade80"
  success-bg: "#14301c"
  success-border: "#1f5c31"
  warning: "#facc15"
  warning-bg: "#2e2712"
  warning-border: "#5c4a12"
  error: "#f87171"
  error-bg: "#3a1d22"
  error-border: "#7f3440"
  error-text: "#f0a8b3"
  stop-bg: "#4a2028"
  purple: "#c084fc"
  diff-add-bg: "rgba(74, 222, 128, 0.09)"
  diff-add-text: "#a7f3c7"
  diff-del-bg: "rgba(248, 113, 113, 0.09)"
  diff-del-text: "#f3b3b3"
  backdrop: "rgba(4, 6, 10, 0.65)"
  breakdown-1: "#6fa8dc"
  breakdown-2: "#57b8c2"
  breakdown-3: "#9a8fd8"
  breakdown-4: "#d88a6f"
  breakdown-5: "#cfa05a"
typography:
  body:
    fontFamily: "\"Noto Sans\", system-ui, -apple-system, \"Segoe UI\", Roboto, \"Helvetica Neue\", Arial, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
  mono:
    fontFamily: "\"Noto Sans Mono\", ui-monospace, \"SF Mono\", Menlo, Consolas, \"Liberation Mono\", monospace"
    fontSize: "0.813rem"
    fontWeight: 400
  title:
    fontFamily: "\"Noto Sans\", system-ui, -apple-system, \"Segoe UI\", Roboto, \"Helvetica Neue\", Arial, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 600
    lineHeight: 1.5
  label:
    fontFamily: "\"Noto Sans\", system-ui, -apple-system, \"Segoe UI\", Roboto, \"Helvetica Neue\", Arial, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 600
    letterSpacing: "0.05em"
rounded:
  xs: "3px"
  sm: "4px"
  md: "6px"
  lg: "8px"
  xl: "10px"
  pill: "999px"
spacing:
  space-1: "2px"
  space-2: "4px"
  space-3: "6px"
  space-4: "8px"
  space-5: "12px"
  space-6: "16px"
  space-7: "24px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.bg}"
    rounded: "{rounded.md}"
    padding: "6px 12px"
  button-primary-hover:
    backgroundColor: "color-mix(in srgb, #7cc7ff, #0f1115 12%)"
    textColor: "{colors.bg}"
    rounded: "{rounded.md}"
    padding: "6px 12px"
  button-base:
    backgroundColor: "{colors.btn}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: "6px 12px"
  button-ghost:
    textColor: "{colors.muted}"
    rounded: "{rounded.sm}"
    padding: "1px 6px"
  chip:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.muted-2}"
    rounded: "{rounded.pill}"
    padding: "2px 16px"
  status-dot:
    backgroundColor: "{colors.muted-2}"
    rounded: "{rounded.pill}"
    size: "8px"
  tool-card:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.text}"
    rounded: "{rounded.lg}"
    padding: "8px 12px"
  modal:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.text}"
    rounded: "{rounded.xl}"
    padding: "16px"
  input:
    backgroundColor: "{colors.bg-deep}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: "4px 8px"
  msg-user:
    backgroundColor: "{colors.accent-dim}"
    textColor: "{colors.text}"
    rounded: "{rounded.xl}"
    padding: "8px 12px"
---

# Design System: omp-web

## Overview

**Creative North Star: "The Mission Control Console"**

One operator, many agents. This UI is the flight-ops room for a fleet of disposable agent daemons: calm, watchful, exact. The screen's job is supervision, not conversation. Surfaces recede so that status (dots, pills, chips, streamed text) can carry the signal. Nothing competes with the readouts; the interface trusts the operator to watch, and earns that trust by never crying wolf.

Density follows the terminal, not the chat app: compact 2–24px spacing rhythm, machine truth set in monospace, labels in small tracked caps, controls that sit quiet until hovered. Depth is nearly absent by doctrine: structure comes from 1px hairlines and tonal panel steps, and shadow appears only when something floats above the console (a modal, a sheet, the lightbox) or when a status light glows.

The palette is a dark instrument panel first: near-black blue-gray surfaces, a softened white readout, and a single Signal Blue accent used with deliberate rarity. Five alternate palettes (light, Catppuccin Mocha/Latte, omp dark/light) rebalance the same semantic slots; the omp pair expresses them in OKLCH.

Confirmed anti-references: chat-app cosplay (rounded messenger bubbles, avatar pairs), AI-slop purple gradients and glow-everything marketing aesthetics, and consumer-SaaS dashboard cards. This is an ops tool, not a landing page.

**Key Characteristics:**
- Dark-first instrument panel; five alternate themes overriding only color tokens
- Flat-by-default surfaces; 1px borders do the structural work
- One accent, used rarely; status speaks in a semantic trio (bg + border + text)
- Zero font assets: system sans + system mono only
- Single 140ms ease-out motion vocabulary; six small keyframes; motion gated behind `prefers-reduced-motion` where animated

## Colors

The palette is a night-shift console: cool near-black surfaces, softened-white text, one sky-blue signal color, and a disciplined set of status hues that always travel as bg/border/text trios.

### Primary
- **Signal Blue** (`#7cc7ff`): the single accent. Focus rings, active/selected washes, links of consequence, the send button, transitional daemon states. Its rarity is the point.
- **Signal Wash** (`#1f3a5f`): accent-tinted surface for selected rows, active segment buttons, pressed chips, user message bubbles.
- **Signal Edge** (`#2d527f`): accent-tinted border paired with Signal Wash on selected states and focus-via-border inputs.

### Neutral
- **Deep Console** (`#0f1115`): the app background; the room the instruments sit in.
- **Console Well** (`#0a0d12`): sunken areas: terminal/code surfaces, the sidebar, settings wells.
- **Instrument Panel** (`#151a22`): resting cards: tool cards, queue chips, modals, the composer.
- **Panel Raised** (`#1a2029`): popovers (autocomplete), inset groups, secondary chips.
- **Control Surface** (`#232a37`): resting fill of buttons and small chips.
- **Hairline** (`#262b36`) and **Hairline Strong** (`#333c4d`): structural borders; the strong variant edges buttons, modals, and emphasized fields.
- **Readout White** (`#d7dae0`): primary text.
- **Muted Readout** (`#8b93a1`), **Faint Readout** (`#7f8896`), **Bright Muted** (`#aab2c0`): the secondary-text ladder: metadata, idle dots, hover targets; bright-muted sits above muted for emphasized secondary labels (titles, stats).
- **Hover Wash** (`#232f42`): universal hover fill.
- **Backdrop** (`rgba(4, 6, 10, 0.65)`): modal/sheet/lightbox scrim.

### Status (semantic trios: always bg + border + text together)
- **Go Green** (`#4ade80` / `#14301c` / `#1f5c31`): ready daemons, streaming dots, clean exits, recommended options.
- **Standby Amber** (`#facc15` / `#2e2712` / `#5c4a12`): queued prompts, reconnecting daemons, running subagents, warning badges.
- **Alarm Red** (`#f87171` / `#3a1d22` / `#7f3440`, text `#f0a8b3`): errors, failed states, stop/danger surfaces (`#4a2028` stop fill), disconnect pills.
- **Auxiliary Violet** (`#c084fc`): rare fourth hue for out-of-band categories.
- **Diff washes**: `rgba(74,222,128,0.09)` add / `rgba(248,113,113,0.09)` delete, with softened text (`#a7f3c7` / `#f3b3b3`).
- **Breakdown ramp** (`#6fa8dc`, `#57b8c2`, `#9a8fd8`, `#d88a6f`, `#cfa05a`): context-usage data-viz only; deliberately disjoint from status hues so a chart never reads as an alert.

### Themes
Six palettes share one semantic contract (~40 slots) and one set of scales; themes override colors only, never radius/spacing/type. The default `:root` is the dark console above; `light`, `catppuccin-mocha`, `catppuccin-latte` restate it in hex/rgba; `omp-dark` / `omp-light` restate it in OKLCH with a magenta signal (`oklch(70% 0.24 340)` dark, `oklch(44% 0.18 348)` light). Per-theme values live in `.impeccable/design.json` → `extensions.themes`. `index.html` resolves `data-theme` before first paint (persisted choice → `prefers-color-scheme` → dark).

### Named Rules
**The One Voice Rule.** The accent appears on ≤10% of any screen: focus rings, the active selection, one primary action. If everything signals, nothing does.

**The Semantic Trio Rule.** A status is never a bare color. Every status surface ships background + border + text from the same trio; bare hue-on-neutral status fills are a defect.

## Typography

**Body Font:** system stack (`"Noto Sans", system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`)
**Mono Font:** system stack (`"Noto Sans Mono", ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace`)
**Display Font:** none: there is no display face and no marketing headline in this UI.

**Character:** the console speaks in two voices: sans for the operator's prose, mono for machine truth (commands, diffs, paths, daemon metadata, the sidebar roster). Both are zero-asset system stacks: the app ships no font files, by doctrine.

The root font size is user-settable (12–18px, `/settings` parity); every scale step below is rem-based and rides that dial.

### Hierarchy
- **Heading** (700, 1rem/1.143rem, 1.3): in-stream markdown h1/h2 and tx section titles: the only type allowed above body size, capped at 16px so it never swamps the session title.
- **Title** (600, 0.875rem, 1.5): modal titles, sidebar section titles, row titles. The highest chrome type is deliberately small: hierarchy comes from weight and color, not size.
- **Body** (400, 0.875rem, 1.5): chat prose, markdown, settings copy.
- **Mono** (400, 0.813rem): code, terminals, diffs, daemon rows, picker metadata (`line-height: 1.4` in the roster).
- **Label** (600, 0.75rem, +0.05em tracking, uppercase): section headers, queue kinds, group headers, usage statuses.
- **Micro** (400, 0.688rem): git dirty counts, debug pills, nested-row metadata: the floor; nothing functional renders below 9.6px.

### Named Rules
**The Zero-Asset Rule.** No webfonts, ever. If a glyph can't come from the system stack, the design is wrong, not the stack.

**The Two-Voice Rule.** Sans is the operator speaking; mono is the machine reporting. Never set machine output (commands, paths, logs, git state) in sans, and never set prose in mono.

## Layout

One centered console column, maximum 820px, full viewport height, 16px side padding: the chat thread is the room. In roster mode a 240px sidebar docks on the **left** (`--sidebar-w`), listing daemons grouped by repo; it takes layout space on desktop and narrows to `width: min(240px, 80vw)` at ≤720px.

Overlays have two geometries: the centered **modal** (min 320px, max 640px, max 80vh) for dialogs, and the right-docked **sheet** (`min(880px, 100vw)`, full height, square outer corners) for working panels: settings, subagents, debug. Sheets go full-viewport at ≤720px, where settings also swaps its nav rail for a section-picker select.

Rhythm is a 2/4/6/8/12/16/24px spacing scale; cards pad at 8–16px, sections separate at 16–24px. The shell breakpoint is 720px; the transcripts view adds a 480px breakpoint. `prefers-reduced-motion: reduce` gates animated elements (see Elevation & Depth for what remains).

## Elevation & Depth

Flat by doctrine. Resting surfaces: cards, chips, sidebar, composer: have zero shadow; structure comes from 1px hairlines and the bg → panel → panel-2 tonal steps. Shadow means one of two things: something is floating above the console, or a status light is lit.

### Shadow Vocabulary
- **Overlay lift** (`0 8px 24px rgb(0 0 0 / 0.35)`): modals, the lightbox image. The only structural shadow.
- **Card kiss** (`0 1px 2px rgb(0 0 0 / 0.25)`): `--shadow-1` is reserved for floating action chips (jump-to-bottom, sidebar toggle); the sprite uses its own `--shadow-sprite`. Quirks, not precedent.
- **Sprite shadow** (`0 2px 6px rgb(0 0 0 / 0.45)`, as `drop-shadow`): canvas sprites only.
- **Status glows** (`0 0 5–6px <status color>`): streaming/ready/reconnecting/error/transitional dots. Glow is a lamp, not elevation.

### Named Rules
**The Flat-By-Default Rule.** Surfaces are flat at rest. Shadow appears only on overlays (`--shadow-2`, which also covers toasts and the jump-to-bottom hover) or as a status glow. Adding a resting-state shadow to a card is a defect.

## Shapes

The form language is the instrument bezel: small, honest radii over hard structure. Controls and inputs curve gently at 6px; cards and popovers at 8px; message bubbles and modals at 10px; code and log wells at 6px. The pill (999px) is reserved for the chip/badge family: queue chips, status pills, toggles, and for the 6–8px status dots that are the system's signature atoms.

Borders are structural, always 1px, always a hairline token; the "asleep" daemon dot even fakes its border as an inset shadow to stay 8px round. Sheets break the radius language deliberately: full-height panels get square outer corners (`border-radius: 0`) because they are the edge of the console, not a card on it.

### Named Rules
**The Hairline Rule.** Separation comes from 1px borders and tonal steps, never from shadow or whitespace alone. If a boundary matters, it gets a hairline.

## Components

### Buttons
Quiet controls that wake on hover; one primary action per view.

- **Shape:** gently curved (6px), padding 6px 12px, `font: inherit`
- **Base:** Control Surface fill + Hairline Strong border; hover swaps to Hover Wash; transition 140ms ease-out on bg + border
- **Primary (send):** Signal Blue fill and border, Deep Console text, weight 600; hover deepens via `color-mix(in srgb, accent, bg 12%)`
- **Ghost / icon:** transparent, Muted Readout text, hairline or no border (4px radius, ~1–4px padding); hover brightens text and may add Signal Edge border; `.armed` (confirm-to-kill) goes Alarm Red
- **Danger / stop:** Alarm Red trio (`error-bg` / `error-border` / `error-text`; stop uses the deeper `#4a2028` fill)
- **Disabled:** `opacity: 0.5`, no cursor change theatre

### Chips & Status Dots
- **Chips:** pill-shaped (999px), Instrument Panel or Control Surface fill, hairline border, 0.75rem text; semantic chips (queued, badges, exit codes, debug pills) use their status trio; selected/pressed state is Signal Wash + Signal Edge
- **Status dots:** 8px circles (6–7px for nested/secondary), Faint Readout at idle. The roster ladder: ready = Go Green + glow, transitional (spawning/connecting/session/resolving) = Signal Blue + glow + 1.2s pulse, reconnecting = Standby Amber + glow, error = Alarm Red + glow, asleep = Faint Readout with an inset hairline ring

### Cards / Containers
- **Tool cards:** Instrument Panel fill, 1px Hairline, 8px radius, 0.813rem text; header pads 8px 12px. Every tool render roots at this shell
- **Message bubbles:** user messages float right in Signal Wash (10px radius, max-width 80%); assistant messages are edge-to-edge: no bubble, no card, by design
- **Code/log wells:** Console Well fill, 6px radius, mono
- **Thinking blocks:** no card at all: a 2px Hairline left rail plus Muted Readout text

### Inputs / Fields
- **Style:** Console Well fill, 1px Hairline, 6px radius, 4px 8px padding (search/history variants use Panel fill, 8px radius)
- **Composer:** Instrument Panel fill, 8px radius, 8px 12px padding, `field-sizing: content` up to 40vh
- **Focus:** one global ring: 2px Signal Blue outline, 1px offset; search-style fields opt out to a Signal Edge border swap instead
- **Error/disabled:** no dedicated input error skin; errors surface as banners and pills in the status trio

### Navigation
- **Daemon sidebar:** Console Well fill, left hairline, mono 0.75rem; rows are 6px-radius ghosts with a transparent border that fills Hover Wash on hover and Signal Wash + Signal Edge when active; group headers are uppercase tracked labels with a rotating caret; per-row git metadata in micro mono with added/modified/deleted/untracked color coding
- **Settings:** desktop nav rail swaps to a section-picker select at ≤720px; both use the same ghost-row language
- **Modals:** Instrument Panel, Hairline Strong border, 10px radius, 16px padding, overlay-lift shadow over the Backdrop scrim; sheets drop radius and keep only their inner border

### Signature: the roster row
The daemon roster row is the product in miniature: status dot (the ladder above) + mono title + micro metadata (cwd, branch, dirty counts) + ghost icon actions that arm red before they kill. If a new surface can't express its state in this vocabulary, the vocabulary should grow a rung: not a new system.

## Do's and Don'ts

### Do:
- **Do** build every surface from the semantic tokens (`var(--bg)`, `var(--panel)`, …) so all six themes stay coherent; themes override colors only.
- **Do** express status as the full trio (bg + border + text): queued, ready, error, and diff states all follow it.
- **Do** keep motion at 140ms ease-out (the single transition vocabulary) and gate anything animated behind `prefers-reduced-motion`.
- **Do** set machine truth in the mono stack at 0.813rem or smaller; the roster lives at 0.75rem/1.4.
- **Do** let assistant output run edge-to-edge; reserve bubbles for the operator's own messages.
- **Do** reach for the pill + hairline + trio pattern for any new chip, badge, or status.

### Don't:
- **Don't** add resting-state shadows or elevation to cards, buttons, or the sidebar (The Flat-By-Default Rule).
- **Don't** introduce gradients, glassmorphism, backdrop-blur chrome, or glow on non-status elements.
- **Don't** chat-app the surface: no avatar pairs, no messenger bubble symmetry, no emoji-forward empty states.
- **Don't** load a webfont or hard-code a font family outside the two system stacks (The Zero-Asset Rule).
- **Don't** invent one-off colors, radii, or spacing outside the token scales; extend the scale or reuse a rung.
- **Don't** use the breakdown data-viz ramp for status, or status hues in charts: the ramps are deliberately disjoint.
