---
title: Contributing
description: Report issues, set up an omp-web development checkout, run the checks, and follow the wire-contract and documentation rules before opening a pull request.
---

omp-web welcomes bug reports, feature ideas, and pull requests. This page is the contributor entry point: it covers the workflow, the local setup, the checks to run, and the conventions that affect what a pull request is allowed to change.

The repository documents remain authoritative. This page summarizes and links; if it ever disagrees with [`CONTRIBUTING.md`](https://github.com/nibblebot/omp-web/blob/main/CONTRIBUTING.md) or [`AGENTS.md`](https://github.com/nibblebot/omp-web/blob/main/AGENTS.md), those files win.

## Report an issue

Search the existing issues before opening a bug report. The issue templates in [`.github/ISSUE_TEMPLATE/`](https://github.com/nibblebot/omp-web/tree/main/.github/ISSUE_TEMPLATE) ask for:

- **Bug report**: what you did, what happened, what you expected, the smallest reliable reproduction, the omp-web version (`omp-web --version`, or the commit when running from source), and your environment (OS, Bun version, install method). Logs and screenshots are optional; remove secrets first.
- **Feature request**: the problem it would solve, the outcome you want, and any alternatives or workarounds you use today.

If you are planning something large, open an issue to discuss it before writing the code.

For runtime failures, [Troubleshooting](/operations/troubleshooting/) lists what to collect from the Debug panel for a bug report.

## First-time setup

Prerequisites are the same as a normal install: [Bun](https://bun.sh) and a configured `omp` CLI with at least one authenticated provider and a default model. Development runners spawn real session daemons, and prompts fail until a model resolves. See [Installation](/getting-started/installation/) for the runtime requirements.

```sh
git clone https://github.com/nibblebot/omp-web
cd omp-web
bun install        # install dependencies
bun run dev        # vite (HMR) + the fleet, the only runtime of the UI
```

The runner chooses ports per run, so several checkouts can run side by side. `bun run dev` also scopes its fleet state per worktree under the data home, so a development fleet coexists with your installed fleet instead of clobbering its roster. `bun run dev:server` runs just the session daemon and `bun run dev:web` just the Vite UI when you want the two halves separately.

## Checks before a pull request

Keep each pull request to one logical change, and run the checks that `CONTRIBUTING.md` requires:

```sh
bun run check:types   # tsgo -p tsconfig.json --noEmit (tsgo, not tsc)
bun run format:check  # oxfmt --check
bun run test          # bun test suite via scripts/test.ts
```

There is no CI, so these local checks are the quality bar. `bun run lint` (oxlint) and `bun run format` (oxfmt, writes TS/TSX in place) are also available; warnings alone do not fail the lint run.

Testing conventions that matter before submitting:

- New behavior needs tests. A bug fix should reproduce the bug first, then confirm the reproduction no longer triggers.
- The heavy suites spawn real processes. Write the run to a log file instead of piping it to `head` or `tail`, which hides failing tests above the summary: `bun run test > /tmp/omp-test.log 2>&1`.
- Run a single file with `bun scripts/test.ts <path>`; extra arguments are forwarded to `bun test`. Filesystem-touching tests create scratch directories with `tempDir()` from `shared/testkit.ts`.
- Tests must not need a live model or API. Do not suppress warnings or errors to make the suite green.

## Code style

- Tabs for indentation; oxfmt formats TS/TSX with a print width of 100. Markdown, CSS, HTML, and JSON stay hand-maintained, so match the surrounding style by hand.
- `verbatimModuleSyntax` is on: use `import type` for type-only imports.
- Comments that cite audit findings keep the `finding #N` numbering from the 2026-08 audit.
- Release changelogs are generated from commit subjects and classified by prefix (`feat:`, `fix:`, `docs:`, and everything else), so descriptive subjects produce better release notes.

## Release machinery

Cutting a release is a maintainer operation. The current procedure lives in [`docs/release.md`](https://github.com/nibblebot/omp-web/blob/main/docs/release.md) and [`scripts/release.ts`](https://github.com/nibblebot/omp-web/blob/main/scripts/release.ts). The "Remaining actions" checklist at the end of `docs/release.md` is carried over from an earlier release plan and predates the current release history (repository creation and the first release are already done), so treat those checkboxes as historical and verify the current version against `package.json` and `CHANGELOG.md` instead of executing them as current work. Changes to the release machinery follow the conventions in `AGENTS.md`.

## Wire protocol caution

The wire contract in `shared/protocol.ts` is **additive-only**. Adding a `WebMethodName`, `ClientCommand` variant, or `ServerFrame` variant is fine. Changing or removing a shape is a breaking change: it requires bumping `OMP_PROTO` and updating the proto gates in `fleet/connector.ts` (hello gate) and `fleet/edge.ts` (pipe gate) so old and new peers fail loudly instead of misparsing.

Two session daemon rules follow from the contract: stdout is reserved for `OMP_SESSION|` contract lines because spawners parse stdout, and all logs go to stderr.

## Preview the documentation site

This documentation is a Starlight site under `docs/`, built from the same checkout and the same `bun install`:

```sh
bun run dev:docs      # Starlight dev server with hot reload
bun run build:docs    # production build (astro build --root docs)
bun run preview:docs  # serve the built site locally
```

Documentation changes follow a few rules:

- Pages live in `docs/src/content/docs/` and use Starlight frontmatter with a `title` and a `description`.
- Navigation is explicit: a new page needs an entry in the sidebar in `docs/astro.config.mjs` to appear in the site.
- Root-relative links to other docs pages use trailing slashes (`/getting-started/installation/`), matching the build's directory URLs.
- The formatter does not cover docs: oxfmt handles TS/TSX only, so `bun run format` and `bun run format:check` leave Markdown, CSS, HTML, and JSON alone.
- Prose uses no em dashes. The per-worktree `omp-session` process is a **session daemon** in user-facing text.
- Describe only what is implemented. Collaboration rooms are hosted and joined through the CLI or TUI, and omp-web has no browser collaboration surface.
- Keep exhaustive lookup tables in their canonical reference page and link to it instead of duplicating it.

## Related

- [Project](/project/): the rest of the project and maintainer material.
- [Installation](/getting-started/installation/): runtime prerequisites and the release installer.
- [Troubleshooting](/operations/troubleshooting/): what to collect for a bug report.
- [CLI commands and flags](/reference/cli/): the fleet and session command surface used while developing.
- [`CONTRIBUTING.md`](https://github.com/nibblebot/omp-web/blob/main/CONTRIBUTING.md): the authoritative contribution workflow and license terms.
- [`AGENTS.md`](https://github.com/nibblebot/omp-web/blob/main/AGENTS.md): the authoritative engineering map, including repo layout, invariants, and the verification workflow.
- [`docs/architecture.md`](https://github.com/nibblebot/omp-web/blob/main/docs/architecture.md): process boundaries, the wire contract, and the module map.
- [`DESIGN.md`](https://github.com/nibblebot/omp-web/blob/main/DESIGN.md): the design reference for the UI.
- [`CHANGELOG.md`](https://github.com/nibblebot/omp-web/blob/main/CHANGELOG.md): shipped changes per release.
