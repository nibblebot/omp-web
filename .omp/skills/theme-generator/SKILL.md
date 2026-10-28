---
name: theme-generator
description: Generate an omp-web custom theme JSON file from an online reference (a URL or the name of a base16/base24 scheme, a terminal color scheme for iTerm2, Alacritty, kitty, Ghostty or Windows Terminal, a Vim/Neovim colorscheme, or a VS Code theme). Fetches the reference, extracts its palette, maps it onto the omp-web theme tokens, writes `<config dir>/themes/<stem>.json`, and runs `omp-web theme check` until there are no schema errors. Use for "make an omp-web theme from X", "port this colorscheme", or "create a theme like <name>".
---

# Theme generator

Turns an existing color scheme into an omp-web theme file. The file format, token meanings, and derivation rules are in `docs/src/content/docs/configuration/custom-themes.md`; the machine-readable contract is `docs/theme-schema.json` (and `THEME_CORE_TOKENS` / `THEME_OPTIONAL_TOKENS` in `lib/themes/types.ts`). Read the docs page before mapping; do not guess token names.

## Rules

- **Core only by default.** A variant must set the nine core tokens: `bg`, `panel`, `text`, `muted`, `border`, `accent`, `success`, `warning`, `error`. Everything else is derived, with `tool-*` and `syn-*` contrast-solved and `muted-2`/`muted-3` lifted to 4.5:1 on `bg` and `panel`. Set an optional token only when the reference pins that role (a `Comment` color, a diff background) or the derived value is visibly wrong. Never invent values for roles the reference does not pin.
- **Colors are hex or oklch only.** Write `#rrggbb` or `#rrggbbaa`. Convert `rgb()`/`rgba()`, `hsl()`, named colors, floats from plists, `0xrrggbb`, and `#aarrggbb` before writing. Anything else is a schema error.
- **Dark and light are separate variants.** Produce `variants.dark` and `variants.light` when the reference has both; otherwise produce the one it has. Never fabricate the missing variant by inverting colors unless the user asks.
- **Ask before replacing** an existing file at the target path. Ask with the existing file's `name`, and offer a different stem.
- **No code changes.** The only file written is the theme file.

## 1. Get the reference

Ask the user for a URL or the name of the scheme if they have not given one. When given a name, find a primary source (the author's repository, the base16 scheme repository, the terminal-scheme collection) with a web search and confirm the match with the user only if several plausible schemes exist. Fetch the raw file, not a rendered page. Prefer `https://raw.githubusercontent.com/...` URLs; rewrite a GitHub `blob` URL to its raw form. Record the source URL for the file's `name` or the final report.

## 2. Identify the format

| Signal | Format |
| --- | --- |
| YAML with `base00` through `base0F` (and `base10`..`base17` for base24), `system: "base16"` or `"base24"` | base16 / base24 |
| XML plist with `Ansi 0 Color` ... `Ansi 15 Color` | iTerm2 `.itermcolors` |
| TOML or YAML with `[colors.primary]`, `[colors.normal]`, `[colors.bright]` | Alacritty |
| Lines `color0 #rrggbb` ... `color15`, `foreground`, `background`, `selection_background` | kitty |
| Lines `palette = 0=#rrggbb`, `background = `, `foreground = ` | Ghostty |
| JSON with `"name"`, `"black"`, `"brightBlack"`, `"purple"`, `"cursorColor"` | Windows Terminal scheme |
| `.vim` file with `hi <Group> guifg=... guibg=...`, or a Lua file calling `nvim_set_hl` | Vim / Neovim |
| JSON(C) with `"colors"` and `"tokenColors"` (or `"semanticTokenColors"`) | VS Code theme |
| Anything else (Xresources, Sublime/TextMate `.tmTheme`, Helix, Zed, JetBrains, CSS variables) | best effort: step 3, last section |

VS Code theme files may contain comments and trailing commas (JSONC); strip them before parsing. A reference that ships several files (one per variant, or per contrast level) means several sources for one theme: pick the standard contrast, and tell the user which files you used.

## 3. Extract the palette and map to tokens

Work per variant. For each source color, convert to `#rrggbb` first. The tables give the first choice; where a cell lists alternatives, take the first one the reference actually defines.

### Check the role split

Whatever the format, first settle these roles from the reference:

| Role | Meaning |
| --- | --- |
| Background | the page color; the `bg` token |
| Foreground | the main text; the `text` token |
| Accent | a saturated blue or the theme's signature color, the one used for links and focus |
| Red / green / yellow | status colors for `error`, `success`, `warning` |

If the reference's red and green are indistinguishable by lightness, keep them anyway (they are pinned); only fill roles the reference does not define.

### base16 / base24

A base16 scheme is one variant: dark if `base00` is darker than `base05`, light otherwise. Siblings published as separate schemes (`name-dark`, `name-light`) become the two variants of one file.

| Token | base16 source | Notes |
| --- | --- | --- |
| `bg` | `base00` | default background |
| `panel` | `base01` | lighter background (status bars) |
| `text` | `base05` | default foreground |
| `muted` | `base04` | dark foreground; keep readable at small sizes, so prefer it over `base03` |
| `border` | `base02` | selection background; if it is nearly identical to `base01`, use `base03` |
| `accent` | `base0D` | blue |
| `success` | `base0B` | green |
| `warning` | `base0A` | yellow |
| `error` | `base08` | red |

Optional tokens, when you choose to set them:

| Token | Source |
| --- | --- |
| `hover` | `base02` |
| `muted-2` | `base04` |
| `muted-3` | `base06` |
| `purple` | `base0E` |
| `syn-keyword` | `base0E` |
| `syn-string` | `base0B` |
| `syn-number` | `base09` |
| `syn-comment` | `base03` |
| `syn-title` | `base0D` |
| `syn-attr` | `base0C` |
| `syn-meta` | `base0F` |
| `bg-deep` (base24) | `base10` |
| `shadow-color` (base24) | `base11`, with alpha (`#rrggbb` + `a6`) |
| `error-text` (base24) | `base12` |
| `diff-add-text` (base24) | `base14` |

`base07` (lightest) is unused. Plain base16 has no darker-than-background shade: leave `bg-deep` derived.

### 16-color terminal palettes

All terminal formats carry the same data: a background, a foreground, optional cursor and selection colors, and ANSI colors 0 to 15 (0 black, 1 red, 2 green, 3 yellow, 4 blue, 5 magenta, 6 cyan, 7 white, 8 to 15 their bright forms).

| Token | Source | Notes |
| --- | --- | --- |
| `bg` | background | |
| `text` | foreground | |
| `panel` | not pinned | shift `bg` toward `text` by 3 to 6 OKLCH lightness points (lighter for dark themes, a touch darker or pure white for light themes) |
| `border` | selection background if distinct from `bg`, else color0/color8 | when none fits, blend `text` into `bg` at about 15% |
| `muted` | color8 (bright black) | if it fails 4.5:1 against `bg`, blend `text` into `bg` at about 60% |
| `accent` | color4 (blue) or color12 | take the one that reads better on `bg`; for a signature accent, the cursor color if saturated |
| `success` | color2 or color10 | brighter form on dark themes, normal on light |
| `warning` | color3 or color11 | same rule |
| `error` | color1 or color9 | same rule |

Optional (set only if each passes 4.5:1 against `panel`, else leave derived): `purple` = color5/13, `syn-keyword` = color5/13, `syn-string` = color2/10, `syn-number` = color3/11, `syn-comment` = color8, `syn-title` = color4/12, `syn-attr` = color6/14, `syn-meta` = color13. `hover` = selection background; `accent-dim` = selection background or `accent` at low alpha.

Where each format keeps the values:

| Format | Background / foreground / cursor / selection | ANSI colors |
| --- | --- | --- |
| iTerm2 `.itermcolors` | `Background Color`, `Foreground Color`, `Cursor Color`, `Selection Color` (each a dict of `Red Component`, `Green Component`, `Blue Component`, floats 0 to 1: multiply by 255 and round; ignore `Color Space` and `Alpha Component`) | `Ansi 0 Color` to `Ansi 15 Color` |
| Alacritty | `[colors.primary] background, foreground`, `[colors.cursor] cursor`, `[colors.selection] background` | `[colors.normal]` and `[colors.bright]`: `black red green yellow blue magenta cyan white` (older YAML uses the same names under `colors:`). Values may be `0xrrggbb` |
| kitty | `background`, `foreground`, `cursor`, `selection_background` | `color0` to `color15` |
| Ghostty | `background`, `foreground`, `cursor-color`, `selection-background` | repeated `palette = N=#rrggbb` lines |
| Windows Terminal | `background`, `foreground`, `cursorColor`, `selectionBackground` | `black red green yellow blue purple cyan white` (purple is magenta) then the `bright*` forms |

### Vim / Neovim colorschemes

Read `guifg`/`guibg` (or `fg`/`bg` in `nvim_set_hl`), resolving `link` chains and `vim.g.terminal_color_*` where a group has no direct color. A colorscheme sets `background=dark` or `light` to say which variant it is.

| Token | Highlight group |
| --- | --- |
| `bg` | `Normal` bg |
| `text` | `Normal` fg |
| `panel` | `NormalFloat` bg, else `Pmenu` bg, else `CursorLine`/`ColorColumn` bg |
| `muted` | `LineNr` fg (or `NonText`); use `Comment` fg only if `LineNr` fails 4.5:1 |
| `border` | `WinSeparator`/`VertSplit` fg, else `FloatBorder` fg, else `CursorLine` bg |
| `accent` | `Function` fg, else `Directory` or `Special` fg |
| `success` | `DiffAdd` fg or `diffAdded`, else `String`-like green, else `DiagnosticOk` |
| `warning` | `WarningMsg` fg, else `DiagnosticWarn` |
| `error` | `Error`/`ErrorMsg` fg, else `DiagnosticError` |
| `hover` | `Visual` bg |
| `accent-dim` | `Visual` bg or `Search` bg |
| `syn-comment` | `Comment` |
| `syn-keyword` | `Statement` (or `Keyword`) |
| `syn-string` | `String` |
| `syn-number` | `Number`, else `Constant` |
| `syn-title` | `Function` |
| `syn-attr` | `Type` |
| `syn-meta` | `PreProc` |
| `diff-add-bg` / `diff-add-text` | `DiffAdd` bg / fg |
| `diff-del-bg` / `diff-del-text` | `DiffDelete` bg / fg |

### VS Code themes

`type` is `dark`, `light`, `hc` or `hcLight`; use it to pick the variant (`hc` as dark, `hcLight` as light). Values in `colors` may be `#rrggbbaa`; keep the alpha only for tokens that overlay (diff backgrounds, `accent-dim`, `backdrop`) and flatten it over `bg` for the rest.

| Token | `colors` key (first defined wins) |
| --- | --- |
| `bg` | `editor.background` |
| `panel` | `sideBar.background`, `editorWidget.background`, `panel.background` |
| `text` | `editor.foreground`, `foreground` |
| `muted` | `descriptionForeground`, `editorLineNumber.foreground`, `sideBar.foreground` |
| `border` | `panel.border`, `editorGroup.border`, `contrastBorder`, `sideBar.border` |
| `accent` | `focusBorder`, `textLink.foreground`, `button.background` |
| `success` | `testing.iconPassed`, `gitDecoration.addedResourceForeground`, `terminal.ansiGreen` |
| `warning` | `editorWarning.foreground`, `list.warningForeground`, `terminal.ansiYellow` |
| `error` | `editorError.foreground`, `errorForeground`, `terminal.ansiRed` |
| `bg-deep` | `activityBar.background`, `titleBar.activeBackground`, `terminal.background` |
| `panel-2` | `sideBarSectionHeader.background`, `editorWidget.background` |
| `btn` | `button.secondaryBackground` |
| `hover` | `list.hoverBackground` |
| `border-strong` | `input.border`, `focusBorder` |
| `accent-dim` | `list.activeSelectionBackground`, `editor.selectionBackground` |
| `diff-add-bg` | `diffEditor.insertedTextBackground`, `diffEditor.insertedLineBackground` |
| `diff-del-bg` | `diffEditor.removedTextBackground`, `diffEditor.removedLineBackground` |
| `diff-add-text` | `gitDecoration.addedResourceForeground` |
| `diff-del-text` | `gitDecoration.deletedResourceForeground` |

`tokenColors` entries are `{ "scope": string | string[], "settings": { "foreground": ... } }`; take the first entry whose scope matches (a scope matches a prefix: `keyword` matches `keyword.control`).

| Token | `tokenColors` scope |
| --- | --- |
| `syn-keyword` | `keyword`, `keyword.control`, `storage.type` |
| `syn-string` | `string` |
| `syn-number` | `constant.numeric`, `constant` |
| `syn-comment` | `comment` |
| `syn-title` | `entity.name.function`, `support.function` |
| `syn-attr` | `entity.name.type`, `support.type`, `entity.other.attribute-name` |
| `syn-meta` | `meta.preprocessor`, `entity.name.tag`, `punctuation.definition.directive` |

### Anything else (best effort)

Collect the visible palette (the scheme's own documentation, screenshots described in the README, or its source variables) and assign by role: background to `bg`, foreground to `text`, the most saturated brand color to `accent`, red/green/yellow to `error`/`success`/`warning`, a slightly offset background to `panel`, a mid-contrast foreground to `muted`, an offset between the two to `border`. Leave everything else derived. Tell the user the mapping was best-effort and which source colors fed which tokens.

## 4. Choose the stem and name

- `stem`: lowercase the scheme name, replace each run of characters outside `[a-z0-9]` with `-`, trim leading and trailing `-`. It must match `[a-z0-9-]+`. Example: `Tokyo Night Storm` becomes `tokyo-night-storm`.
- Built-in stems are `catppuccin`, `gruvbox`, `everforest`, `tokyo-night`, `nord`, `kanagawa`, `rose-pine`, `poimandres`, `dark-volcanic`. A custom file with one of those stems overrides the built-in (the picker shows "modified"). Use such a stem only when the user wants an override; otherwise pick a different one.
- `name`: the scheme's display name, a non-empty string. When the file holds both variants of a family, use the family name without "Dark"/"Light".

## 5. Write the file

Config dir = the directory of the fleet config file: `~/.omp-web/` by default, or `dirname $OMP_FLEET_CONFIG` when that variable is set (or the directory of a `--config` file the user runs the fleet with). Create `<config dir>/themes/` if missing. Target: `<config dir>/themes/<stem>.json`.

If the target exists, ask the user whether to replace it, keep it and write under a new stem, or stop. Never overwrite silently.

File shape (tabs; omit `variants.light` or `variants.dark` when the reference lacks it):

```json
{
	"$schema": "https://raw.githubusercontent.com/nibblebot/omp-web/main/docs/theme-schema.json",
	"schemaVersion": 1,
	"name": "<display name>",
	"variants": {
		"dark": {
			"bg": "#rrggbb",
			"panel": "#rrggbb",
			"text": "#rrggbb",
			"muted": "#rrggbb",
			"border": "#rrggbb",
			"accent": "#rrggbb",
			"success": "#rrggbb",
			"warning": "#rrggbb",
			"error": "#rrggbb"
		}
	}
}
```

## 6. Check and iterate

```sh
omp-web theme check <config dir>/themes/<stem>.json
```

In a source checkout without the installed command, run `bun apps/cli/omp-web.ts theme check <file>`. The command prints schema errors, contrast warnings per variant, and the resolved tokens. It exits non-zero only on schema errors (or an unreadable file or bad stem).

1. **Schema errors** (unknown key, missing core token, bad color, bad stem): fix each and re-run until there are none. These are never acceptable to leave.
2. **Contrast warnings** are informational and never block the theme. Review each one:
   - If the failing color is one the reference pins (it came straight from the source palette), leave it. The reference's author chose it.
   - If the failing color is one you chose or derived (for example a `muted` from the blend rule, a `panel` you shifted, a terminal-palette color with no source), adjust only that color, in small OKLCH lightness steps, and re-run.
   - Do not change a pinned color to silence a warning, and do not set `tool-*` or `syn-*` tokens just to fix warnings: the derived ones are contrast-solved already.
3. Stop when there are no schema errors and every remaining warning is on a color the reference pins. Explain each remaining warning to the user: which pair, the ratio, and that it comes from the reference.

## 7. Report

Tell the user: the file path, which variants were written, the source URL, any best-effort or substituted mappings, the remaining warnings with their causes, and: press **Reload themes** in the Appearance sheet (Theme & text) to see it, then pick it in the theme picker. Mention that the stem `<stem>` is the theme id and that deleting the file removes it.
