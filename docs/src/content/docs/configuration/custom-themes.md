---
title: Custom themes
description: Write a JSON theme file, drop it in the themes directory, and pick it in the Appearance sheet. Covers the file format, derived tokens, contrast warnings, the picker, and the omp-web theme check command.
---

omp-web ships nine built-in themes. **Catppuccin** (the default), **Gruvbox**, **Everforest**, **Tokyo Night**, **Kanagawa**, and **Rosé Pine** each have a dark and a light variant; **Nord**, **Poimandres**, and **Dark Volcanic** are dark-only, because their sources publish no light variant. You can add your own, or override a built-in, by putting a JSON file in the themes directory. The fleet only reads the directory; it never writes there.

## Where theme files go

Theme files live in `themes/` next to the fleet config file: `<config dir>/themes/<stem>.json`. The default config directory is `~/.omp-web/`, so the default themes directory is `~/.omp-web/themes/`. If you point the fleet at a different config file, the themes directory moves with it. The directory does not have to exist: without it you get the built-in themes and no error.

- The file stem is the theme id and must match `[a-z0-9-]+`. A file named `Solar Flare.json` or `solar_flare.json` is a load failure; `solar-flare.json` works.
- Only `*.json` files are read. Other extensions and dotfiles are ignored.
- The directory is read on every request. There is no file watcher: after you edit a file, press **Reload themes** in the picker.

### Overriding a built-in

A custom file whose stem equals a built-in id (`catppuccin`, `gruvbox`, `everforest`, `tokyo-night`, `nord`, `kanagawa`, `rose-pine`, `poimandres`, `dark-volcanic`) replaces that built-in. The picker shows a **modified** badge on it. Delete the file to restore the built-in. If the override fails validation it is listed as a failure and the built-in stays in place.

## File format

```json
{
	"$schema": "https://raw.githubusercontent.com/nibblebot/omp-web/main/docs/theme-schema.json",
	"schemaVersion": 1,
	"name": "Midnight",
	"variants": {
		"dark": { "...": "..." },
		"light": { "...": "..." }
	}
}
```

| Key | Required | Meaning |
| --- | --- | --- |
| `$schema` | no | Schema URL, for editor completion and validation. |
| `schemaVersion` | yes | Integer `1`. |
| `name` | yes | Non-empty display name. |
| `variants` | yes | An object with `dark`, `light`, or both. At least one is required. |

Unknown keys are errors, at the top level, in `variants`, and in each variant. The machine-readable schema is [`docs/theme-schema.json`](https://github.com/nibblebot/omp-web/blob/main/docs/theme-schema.json) (JSON Schema 2020-12). The `$schema` property is optional and omp-web does not fetch it.

### Schema version policy

`schemaVersion` is an integer. A file with a newer version than the running omp-web understands is rejected with an explicit error, so upgrade omp-web instead of editing the file. Older versions are migrated step by step when loaded. Only version 1 exists today.

## Tokens

Each variant is a flat object of token names to colors. Nine **core** tokens are required; every other token is **optional** and derived from the core when omitted.

### Core tokens (required)

| Token | Paints |
| --- | --- |
| `bg` | Page background. |
| `panel` | Raised surfaces: cards, dialogs, popovers, the sidebar. |
| `text` | Primary text. |
| `muted` | Secondary text: labels, timestamps, hints. |
| `border` | Default borders and dividers. |
| `accent` | Links, focus rings, selected state, primary actions. |
| `success` | Success status. |
| `warning` | Warning status. |
| `error` | Error status. |

### Optional tokens

Set one only when the derived value is not what you want; a value you set is kept exactly as written.

| Group | Tokens |
| --- | --- |
| Surfaces | `bg-deep`, `panel-2`, `btn`, `hover`, `border-strong`, `backdrop`, `shadow-color` |
| Text | `muted-2`, `muted-3`, `shimmer-band`, `error-text` |
| Accent | `accent-dim`, `accent-border`, `purple` |
| Status surfaces | `success-bg`, `success-border`, `warning-bg`, `warning-border`, `error-bg`, `error-border`, `stop-bg` |
| Diff | `diff-add-bg`, `diff-add-text`, `diff-del-bg`, `diff-del-text` |
| Tool categories | `tool-shell`, `tool-read`, `tool-write`, `tool-search`, `tool-agents`, `tool-other` |
| Syntax | `syn-keyword`, `syn-string`, `syn-number`, `syn-comment`, `syn-title`, `syn-attr`, `syn-meta` |
| Settings | `settings-accent`, `settings-title`, `settings-desc`, `settings-warning`, `settings-line`, `settings-divider`, `settings-fill`, `settings-track-off`, `settings-mark-bg`, `settings-mark-fg` |
| Logo | `logo-tile`, `logo-base` |

The schema file carries a one-line description for every token.

### Derivation

Omitted optional tokens are computed from the core tokens into concrete color values, once, when the theme loads. Nothing is blended in the browser at runtime. The `tool-*` and `syn-*` tokens are contrast-solved: each starts from a fixed hue (tool hues avoid red and green so they never read as diff or status colors) and its lightness is adjusted in OKLCH until it reaches at least 4.5:1 against `panel`, `bg-deep`, and the diff backgrounds composited over `panel`. If you set a `tool-*` or `syn-*` value yourself, it is used as written, whatever its contrast.

### Color formats

Exactly these forms are accepted:

- `#rgb`
- `#rrggbb`
- `#rrggbbaa`
- `oklch(L% C h)`, for example `oklch(72% 0.14 250)`
- `oklch(L% C h / a)`, for example `oklch(72% 0.14 250 / 0.4)`

Anything else (`rgb()`, `hsl()`, named colors, `color-mix()`, `var()`) is a schema error. Tokens that overlay other surfaces (`backdrop`, `shadow-color`, `diff-add-bg`, `diff-del-bg`, `accent-dim`) usually carry alpha.

## Examples

A complete minimal theme with both variants: the nine core tokens only, everything else derived.

```json
{
	"$schema": "https://raw.githubusercontent.com/nibblebot/omp-web/main/docs/theme-schema.json",
	"schemaVersion": 1,
	"name": "Harbor",
	"variants": {
		"dark": {
			"bg": "#10161c",
			"panel": "#18212a",
			"text": "#d6dee6",
			"muted": "#8b9aa8",
			"border": "#2a3744",
			"accent": "#5cb3e6",
			"success": "#7fd18b",
			"warning": "#e6c15c",
			"error": "#ef7f86"
		},
		"light": {
			"bg": "#f3f6f9",
			"panel": "#ffffff",
			"text": "#1c2a36",
			"muted": "#566676",
			"border": "#cfd9e2",
			"accent": "#0a62a8",
			"success": "#1f7a3a",
			"warning": "#8a5a00",
			"error": "#b3261e"
		}
	}
}
```

A single-variant theme, with a few optional tokens set explicitly. It appears only for the dark scheme; in the linked picker it is a half row, and picking it unlinks the pair (see below).

```json
{
	"schemaVersion": 1,
	"name": "Ember (dark only)",
	"variants": {
		"dark": {
			"bg": "oklch(18% 0.02 40)",
			"panel": "oklch(23% 0.025 40)",
			"text": "oklch(90% 0.02 70)",
			"muted": "oklch(68% 0.03 60)",
			"border": "oklch(33% 0.03 40)",
			"accent": "oklch(75% 0.15 55)",
			"success": "oklch(78% 0.14 150)",
			"warning": "oklch(82% 0.14 90)",
			"error": "oklch(70% 0.18 25)",
			"backdrop": "oklch(10% 0.01 40 / 0.65)",
			"syn-keyword": "#d9a35f"
		}
	}
}
```

## Contrast warnings

omp-web checks the text and status pairs that matter, and the contrast-solved tokens, on every resolved variant, built-ins included. Findings are warnings only. They never stop a theme from loading and never change a color. Schema errors are the only thing that rejects a file. Warnings are reported only by `omp-web theme check`; the picker does not show them.

## Choosing a theme

Open the **Appearance** sheet and use the **Theme & text** group.

- **Mode** is a segmented control: **System** (default), **Light**, or **Dark**. System follows the operating system's color scheme and switches live when it changes.
- The theme picker chooses a **light theme** and a **dark theme** together. By default the two are **linked**: each row is split into a dark half and a light half, each painted in its own colors, and picking a row sets both schemes. Picking a theme applies it at once and leaves the list open, so you can click through several themes; Escape or the trigger closes it. Themes with only one variant also appear, as half rows. Picking one unlinks the pair and sets only that scheme.
- The **chain toggle** unlinks the pair into two pickers, **Light theme** and **Dark theme**. Each lists every theme that has that variant. Selecting the chain again relinks: both schemes switch to the family of the variant currently in effect if it has both variants, otherwise to Catppuccin.
- The picker footer shows the themes directory, a **Reload themes** action, and, when any file failed, "N theme files failed to load". Expand it for each file and the reasons. Rows show a **modified** badge for a built-in overridden by your file, and a selected state.

If the theme you selected is later deleted or becomes invalid, the interface renders Catppuccin for that scheme and the picker shows "Selected theme unavailable". Your choice is kept, so fixing or restoring the file brings the theme back after **Reload themes**.

Selection is stored in the browser (`omp-web:theme-mode`, `omp-web:theme-linked`, `omp-web:theme-light`, `omp-web:theme-dark`) and is per browser origin. The previous single `omp-web:theme` setting and the removed Default and OMP themes are not migrated: a browser that had one starts on Catppuccin with Mode System.

## Check a theme from the terminal

```sh
omp-web theme check ~/.omp-web/themes/harbor.json
```

The command runs the same load path as the fleet: stem rule, version migration, validation, derivation, and contrast checks. It prints:

1. schema errors, if any,
2. contrast warnings, per variant,
3. the fully resolved tokens of each variant (explicit and derived).

The exit code is non-zero only for schema errors, an unreadable file, or a stem that does not match `[a-z0-9-]+`. Contrast warnings alone exit 0. The command reads the file you name; it does not need a running fleet.

## Generate a theme from an existing palette

The repository includes an agent skill, `.omp/skills/theme-generator/SKILL.md`. Give it a URL or the name of a theme (a base16 or base24 scheme, a terminal color scheme, a Vim or Neovim colorscheme, a VS Code theme) and it fetches the palette, maps it to the tokens above, writes `<config dir>/themes/<stem>.json`, and runs `omp-web theme check` until the file has no schema errors. It asks before replacing an existing file. Afterwards press **Reload themes** in the Appearance sheet.
