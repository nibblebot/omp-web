---
title: Installation
description: Install omp-web from a SHA-256-verified GitHub release and prepare Bun, the omp CLI, provider authentication, and a default model.
---

`omp-web` is installed from GitHub releases through Bun. Use the release installer rather than a global package command: it downloads a tarball, verifies it against the release manifest, and links one `omp-web` command.

## Prerequisites

- **Bun 1.3.14 or newer.** Bun is both the runtime and the only supported installation path. Upgrade instructions live in the [Bun installation docs](https://bun.sh/docs/installation); the installer stops with `Bun 1.3.14 or newer is required. Current version: <version>` when an older Bun is already present, and it does not upgrade Bun for you.
- **The `omp` CLI, with at least one authenticated provider and a default model.** Run `omp` and configure a provider and default model in its `/settings`, or run `omp login` for an OAuth provider. omp-web resolves `omp` from `PATH`, then from `~/.bun/bin/omp`; when it is missing, the first-run check prints the install command to run, `bun install -g @oh-my-pi/pi-coding-agent`.

On an interactive first run with no config file yet, omp-web probes this setup and prints the `omp` path, the usable providers, and the default model. The check is advisory: the web UI still starts without them, but prompts fail until a model resolves.

## Install from a release

```sh
curl -fsSL https://raw.githubusercontent.com/nibblebot/omp-web/main/scripts/install.sh | sh
```

The installer:

1. Installs Bun when Bun is absent, then requires Bun 1.3.14 or newer.
2. Resolves the latest [GitHub release](https://github.com/nibblebot/omp-web/releases), downloads `omp-web-<version>.tgz`, and downloads that release's `release-manifest.json`.
3. Computes the tarball SHA-256 and compares it with the digest pinned in the manifest before installing anything. It uses `sha256sum` when present and falls back to `shasum -a 256`; when neither utility exists it stops with `Neither sha256sum nor shasum found; cannot verify the download`. A mismatch stops with `sha256 mismatch for omp-web-<version>.tgz: expected <sha>, got <sha>`. Downloads are never installed unverified.
4. Installs the tarball into its own pinned directory (`~/.omp-web/install/`) and links `~/.bun/bin/omp-web` (or `$BUN_INSTALL/bin/omp-web`) to the bundled CLI. An existing pinned install is upgraded in place. Keeping the bundle out of the global Bun store avoids version skew with the dependencies the `omp` CLI installs globally. The package's `patchedDependencies` are then mirrored into that directory and re-resolved (see [Updates](../operations/updates.md)), because Bun applies patches only from the project root.

The installer links the command into `$BUN_INSTALL/bin`, which defaults to `~/.bun/bin`. If your shell cannot find `omp-web` after installing, check that this directory is on `PATH` and start a new shell. Do not add untrusted directories to the front of `PATH` to fix a lookup: the command is a symlink into `~/.omp-web/install/`, and adding that directory itself to `PATH` is not needed.

## Verify the installation

```sh
omp-web --version
```

`omp-web --version` and `omp-web version` both print the installed version as a single line and exit successfully.

## Keep the install current

```sh
omp-web update          # install the newest release
omp-web update --check  # report the newest release without installing
omp-web update --version x.y.z  # pin a specific release
```

## Next steps

Continue to [First run](/getting-started/first-run/) to start the fleet and choose the data home, then [add your first project](/getting-started/add-first-project/). Installing from source with `bun run install:omp-web` is documented under Manual install in the [README](https://github.com/nibblebot/omp-web#manual-install).
