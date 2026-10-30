# Contributing

Thanks for wanting to help with omp-web! Bug reports, feature ideas, and pull requests are all welcome.

## Issues

- **Before opening a bug report**, check the existing issues for a match.
- Include: what you did, what you expected, what happened, and your environment (OS, bun version, how you installed omp-web).
- If you can, paste the relevant error output and the session log if one exists.

## Pull requests

- Keep changes focused, one logical change per PR. If you're planning something large, open an issue first to discuss it.
- Run the checks before submitting:
  - `bun run check:types`
  - `bun run format:check`
  - `bun run test`
- New behavior needs tests. Changes to the wire protocol or the release machinery must follow the conventions in `AGENTS.md`.
- Follow the existing code style (tabs, oxfmt formatting, applied by `bun run format`).

## Develop

```sh
bun run dev                # bun install, first-run setup if unconfigured, then Vite HMR + fleet; open the printed ui URL
```

Dev opens the browser only when run from an interactive local terminal with a display and without `--host`; `--no-open` disables it. Use the printed `ui` URL, not the fleet's potentially stale `dist/` UI. Dev-spawned sessions run with a 2s `--control-grace` (production keeps 10 minutes), so they shut themselves down about 2 seconds after dev stops, however it stops. The dev fleet listens on a stable per-worktree port, so a dev restart within that window lets them redial; if that port is taken it picks a free one and says so, and the surviving sessions then exit at the end of their grace. Restart dev-spawned sessions after server edits (stop them from the UI, or restart dev and wait out the grace); they are not watched.

`bun run dev --host` serves Vite on the LAN. Vite's proxy re-presents each LAN page's same-origin request to the loopback fleet, so dev needs no browser origin; `--allow-hosts` still decides which Host names Vite accepts. Only same-origin requests are re-presented: a cross-site Origin still reaches the fleet unchanged and is refused.

Source imports into `lib/` use extensionless `#lib/<path below lib/>`, such as `#lib/wire/protocol`, through root `package.json`'s imports mapping. Keep local imports such as `./helpers` relative. Shared libraries are closed: their repository imports stay inside `lib/`, with no library cycles, enforced by `bun run lint`.

In a linked worktree, `bun run dev` copy-once forks the main worktree's existing **dev** fleet state when available; otherwise it starts empty. Later runs keep the diverged roster. `--state-from <path>` seeds from an explicit state file or directory, while `--fresh` deletes this worktree's existing dev roster and skips seeding. Dev state lives outside the repo at `<data home>/dev-fleets/<slug>-<hash8>/` (worktree basename and sha-256 prefix of its realpath), which records the worktree's realpath in a `worktree` file. Every `bun run dev` removes the dev-fleets dirs whose recorded worktree no longer exists (its parent directory must still exist, so an unmounted volume does not count), unless a running dev fleet holds that dir's lock; dirs created before the `worktree` file existed are never removed automatically. Config and the managed-workspace root remain shared across dev stacks; a separate dev roster does not isolate workspace storage.

By default, development starts only the fleet and Vite, with no managed auth broker or automatic credential configuration. Production `omp-web` never manages broker startup. Local sessions use the user's ordinary SDK credentials.

### Design system

```sh
bun run design             # component stories on http://localhost:4799/ (OMP_DESIGN_PORT overrides)
bun run demo               # App demo on http://localhost:4798/ (OMP_DEMO_PORT overrides)
bun run build:demo [dir]   # static App demo (default apps/design-system/dist/)
```

The two are standalone pages that do not link to each other, and each opens in the default browser on start when run from an interactive local terminal with a display, never when an agent or CI runs it (same rule as `omp-web`). `bun run design` serves the stories: a sidebar of every component story, with routes under `#/stories` (`#/stories/coverage`, `#/stories/<storyId>`). `bun run demo` serves the App view: the real app in Chat Mode with fixture data. Hold Shift to label the component under the pointer and its ancestors (Ctrl+Shift labels every component), then click a label to inspect it in an isolated iframe. `bun run build:demo` writes the same demo page as a static site (`index.html`, `main.js`, `main.css`, minified, no sourcemap) that works from any path; the GitHub Pages workflow (`.github/workflows/pages.yml`) publishes it at https://nibblebot.github.io/omp-web/demo/ next to the docs site at https://nibblebot.github.io/omp-web/docs/ on every push to `main`.

`apps/design-system/` is a standalone Bun server that bundles the real `apps/web` components (Babel with `babel-preset-solid`) and shows each one with fixture data. No fleet runs behind it: control-plane fetches (`/ctl`, `/auth`) are answered in the page from `apps/design-system/fixtures/routes.ts` (the server only serves the page and its bundle), session commands and `call()` answers come from story handlers in `apps/design-system/session.ts`, and stories seed the shared store through `seed`. The store, the fake session, and module-level dialog state reset before every story and variant. On the stories page the sidebar is computed from the component graph (`graph.ts`): it starts at `App` and drills down through what each component renders, opening the path to the current story. Where a component renders several pieces from another feature folder, they sit under a folder row for that feature (`chat/`), split again by subfolder (`status/`), so App and ModalHost show a few big pieces rather than every component; `ui/` primitives and the Icons page are listed below the tree, and exported components nothing renders are listed under "Not rendered by App". The search box replaces the tree with a flat list of matches. `#/stories/coverage` lists every exported component and whether it has a story. Refresh the page to rebuild after source edits; restart the server after editing `server.ts` or fixture routes. Add a story by creating `apps/design-system/stories/<feature>/<subfolder>/<Name>.tsx`, mirroring the component's folder, whose default export is a `defineStory(...)` (or an array of them); see `registry.ts` for the contract.

## Engineering map

See `AGENTS.md` for the full engineering map: repo layout, the wire contract, invariants, and verification workflow.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
