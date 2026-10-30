---
title: Installation
description: "Requirements, the one-line installer, verifying the install, updating, and installing from a repository checkout."
---

## Requirements

- [Bun](https://bun.sh) **1.4.4 or newer** (the runtime and installer). The one-line installer installs Bun when absent; upgrade an existing older installation first.
- The **`omp` CLI** with usable provider credentials and a default model configured: run `omp` to configure it, or `omp login` for an OAuth provider. An interactive first run with no fleet config checks this setup; missing setup warns but does not prevent the fleet from starting. Prompts need a usable model and credentials.

## Install

```sh
# One-liner (bun-only; installs bun >= 1.4.4 if missing):
curl -fsSL https://raw.githubusercontent.com/nibblebot/omp-web/main/scripts/install.sh | sh
```

The installer downloads the latest release tarball, verifies its sha256 against the release manifest, and installs it into a pinned project dir (`~/.omp-web/install/`) with a `~/.bun/bin/omp-web` symlink by default (or `$BUN_INSTALL/bin/omp-web`). Put that bin directory on `PATH`. Then `omp-web update` keeps it current.

## Verify

```sh
omp-web --version
```

Run `omp-web` in a terminal to start the fleet and open the UI in your browser (elsewhere, open its printed URL). Register a repository in the UI, start or select a session, and send a prompt. Local sessions use your ordinary SDK credentials.

## Self-update

```sh
omp-web update                          # install the latest release if newer
omp-web update --check                  # check for an update without installing
omp-web update --version x.y.z          # select a specific newer release
omp-web update --force --version x.y.z  # reinstall or downgrade to a specific release
```

`--version` selects a release for this invocation, not a durable pin; a future bare update still checks the latest release. After updating, stop the running control plane (Ctrl+C) and start it again. Running sessions survive that restart on the code they started with; `omp-web stop all` ends them so the next attach or prompt starts them on the new release.

## Manual install

Install from this repo (build → pack → install):

```sh
git clone https://github.com/nibblebot/omp-web.git && cd omp-web
bun install
bun run install:omp-web       # build → pack → install into ~/.omp-web/install/
omp-web --version             # verify: prints <version>
```
