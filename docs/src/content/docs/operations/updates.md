---
title: Updates
description: Update an installed omp-web from the release channel, reinstall or pin a specific release, replace a source install, and restart the fleet and session daemons safely after an update.
---

omp-web is distributed as release tarballs on GitHub Releases. `omp-web update` checks that channel, downloads the newest tarball, verifies its SHA-256 against the release manifest, and replaces the pinned install in place. Running processes are not touched: a fleet or session daemon that is already running keeps executing the old build until you restart it.

## Prerequisites

- omp-web installed into a pinned directory, either from a release with the installer or from source with `bun run install:omp-web`. Update replaces that pinned install; a checkout that was never installed has nothing to replace.
- A `bun` executable on `PATH`. The update shells out to `bun remove` and `bun add` inside the install directory.
- Network access to the release channel. The default channel is GitHub Releases; `OMP_WEB_UPDATE_URL` points the command at a different base.

You do not need to stop the fleet before updating. Running fleets and session daemons keep working on the old build; see [Restart after updating](#restart-after-updating).

## Check for and install the newest release

```sh
omp-web update --check   # report the newest release without installing anything
omp-web update           # download, verify, and install it
omp-web --version        # confirm the version now on disk
```

Expected result:

- `--check` prints the newer version to stdout when the channel has one. When the installed version is already current it prints `omp-web is up to date (<current>)` instead. Both cases exit 0.
- `omp-web update` prints `omp-web updated to <version>` after the new package is installed and read back from disk.
- `omp-web --version` prints that same version. The command path (`~/.bun/bin/omp-web`, or `$BUN_INSTALL/bin/omp-web`) is a symlink into the pinned install and does not change.

Any failure prints to stderr with an `omp-web:` prefix and exits 1.

## What the update does

1. Resolves the version of the running command. An installed bundle carries its release version as a build stamp, falling back to the package version next to it; a source checkout without an install resolves `dev`.
2. Fetches `release-manifest.json` from the channel base. The manifest must be a JSON object with non-empty string fields `version`, `tarball`, and `sha256`; extra keys are tolerated.
3. Compares the manifest version with the installed version. Versions compare by numeric dot-segments, so `1.2` equals `1.2.0` and a non-numeric `dev` build sorts below every release. A manifest that is not newer stops as up to date without touching the install unless `--force` is passed.
4. Downloads the tarball named by the manifest.
5. Computes its SHA-256 in memory and compares it with the manifest digest. A mismatch aborts before anything touches disk. Verification covers integrity of the download; it does not vouch for the channel itself, so use the official channel or a mirror you trust, over HTTPS.
6. Writes the verified bytes to a temporary file, runs `bun remove omp-web` and then `bun add <tarball>` inside the pinned install directory (`~/.omp-web/install/` in the standard layout), mirrors the package's `patchedDependencies` into that directory and re-resolves, and deletes the temporary file on every exit path. Bun applies `patchedDependencies` only from the project root, so a dependency's own map is ignored: the mirror step copies the shipped patch files next to the install (outside `node_modules/omp-web`, which the remove/add cycle replaces) and re-applies them, which is also what keeps the patch active across updates.
7. Reads the installed package version back to confirm the flip, prints the result, and probes the fleet control plane.

The update installs into omp-web's own pinned project directory, not the shared global Bun store: a global store is flat and shared with the `omp` CLI, which holds one `@oh-my-pi` version of its own. The same-name re-add after a remove is deliberate, because re-adding the same path tarball over an existing install trips Bun's dependency-loop check.

## Install or roll back a pinned release

```sh
omp-web update --version 0.2.0          # install a specific release
omp-web update --force                  # reinstall even though the channel is not newer
omp-web update --version 0.1.0 --force  # move back to an older release
```

`--version` requires an argument. It rewrites the channel base to the per-release asset path (GitHub layout: `.../releases/download/v<x.y.z>`), so the manifest and tarball come from that release only. A pin whose version is older than or equal to the installed version is refused as up to date unless `--force` is also passed. That is the supported rollback: there is no snapshot or undo, so returning to an earlier build means reinstalling it explicitly.

## Update a source install

The manual install path is the supported alternative to release updates:

```sh
git clone https://github.com/nibblebot/omp-web && cd omp-web
bun install
bun run install:omp-web        # build, pack, install into ~/.omp-web/install/, link the bin
omp-web --version              # verify
```

The script accepts a prebuilt artifact and alternate locations:

```sh
bun run install:omp-web ./omp-web-0.2.0.tgz
bun run install:omp-web --prefix ~/.omp-web --bin-dir ~/.bun/bin
```

To update such an install, pull the source and run `bun run install:omp-web` again. It packs the current checkout and replaces the same pinned install, and it also removes any stale `bun install -g omp-web` copy. Do not mix a source install with `omp-web update`: the updater replaces the pinned directory with a release tarball.

A checkout that is only run from source, such as `bun dev`, is not an install. `omp-web update` refuses to run there:

```text
omp-web: updates apply to installs (running from dev source; pass --force --version to override)
```

Updating that checkout means pulling with Git and restarting the fleet or session daemon. The `--force --version` override only applies when the running command lives in a pinned install; from a plain source run the install step additionally reports that omp-web is not installed in a pinned directory and to reinstall with the installer first.

## Restart after updating

Replacing files under the pinned install has no effect on processes that are already running. The fleet, each spawned session daemon, and the web UI bundle it serves stay on the old build until the process restarts; processes started later run the new build.

- When the fleet control plane answers on the default loopback port `127.0.0.1:4722`, `omp-web update` appends a line telling you the running fleet predates this install and should be restarted. The probe uses that default port only, so a fleet started on another port is not detected; restart it by hand.
- Restart the fleet from the terminal that runs it: Ctrl+C (or SIGTERM) stops the fleet cleanly, which terminates its spawned session daemons (SIGTERM, then SIGKILL after 5 seconds) and keeps their registry entries. Starting `omp-web` again brings up the new fleet, and session daemons spawned or woken afterwards run the new build; a respawn with a recorded session file resumes it with `--resume`.
- If the fleet was killed with SIGKILL it cannot stop its children. After the new fleet is up, stop the leftover rows you want off the old build (`omp-web stop <selector>`) and wake them again so they respawn from the new install.
- Session daemons you started yourself, in single-session mode, or registered on another host through SSH or a container are not children of the fleet; the fleet dials in to their endpoints. They are not stopped or updated by the fleet restart; restart them on their host to move them to the new build.
- The browser tab shows `reconnecting` while the fleet is down and reattaches once the new fleet answers.

## Protocol compatibility

The fleet verifies each session daemon's protocol version during the connection handshake. A daemon whose `OMP_PROTO` differs from the fleet's is not drivable: the connector records `proto mismatch: daemon speaks OMP_PROTO <actual>, expected <expected>` and the row stays in error until a compatible daemon is respawned. A release that bumps the protocol therefore requires the fleet and the session daemons it drives to move together:

- Locally spawned session daemons pick up the new build the next time they are spawned, woken, or restarted after an idle exit. Idle session daemons exit on their own after the idle timeout (30 minutes by default) and are respawned on demand, so an untouched machine also converges on the new build.
- Remote session daemons keep whatever build they run until you update and restart them on their host, so update both sides before expecting mixed-version rows to attach.
- The browser does not schedule its reconnect loop after a protocol mismatch, since retrying cannot fix incompatible versions. Update, restart, then reload the page. See [Troubleshooting](/operations/troubleshooting/) for the related connector and browser messages.

Session transcripts are durable JSONL files and are not changed by an update. The surrounding wire protocol, configuration, and state formats are still early-stage and may change between releases; the changelog and release notes describe what moved.

## When an update fails

Every failure prints to stderr with an `omp-web:` prefix and exits 1. Common cases:

- `update manifest request failed (HTTP <status>)` or a tarball download failure: the channel is unreachable or the network is blocked. The install is untouched.
- `update manifest is missing a string 'version'` (and the same for `tarball` or `sha256`), or `update manifest is not valid JSON`: the channel is serving a bad manifest. The install is untouched.
- `sha256 mismatch for <tarball>: expected <sha>, got <sha>`: the downloaded bytes do not match the manifest. Nothing is installed; retry, and if it repeats, treat the channel as compromised and do not install from it.
- `bun add failed (exit <code>)`: the install into the pinned directory failed. The package was removed before the add, so the pinned install can be left without an `omp-web` package and the command stops working. Recover by reinstalling: rerun the release installer, or run `bun run install:omp-web` from a source checkout.

```sh
# Reinstall a specific release directly with the release installer
curl -fsSL https://raw.githubusercontent.com/nibblebot/omp-web/main/scripts/install.sh | sh -s -- --ref v0.2.0
```

There is no automatic rollback on failure. A failed download or verification leaves the existing install in place; a failed add may leave the pinned directory empty and needs a reinstall.

## Use a different channel

`OMP_WEB_UPDATE_URL` replaces the default GitHub Releases base (`https://github.com/nibblebot/omp-web/releases/latest/download`). The base must serve `release-manifest.json` in the shape above and the tarball it names. A `--version x.y.z` pin resolves both assets under `<base>/download/v<x.y.z>` unless the base already ends in `latest/download`, in which case that suffix is rewritten to `download/v<x.y.z>`, matching the GitHub layout. Every release publishes both assets under exactly those names, so a mirror or internal channel must copy them unchanged.

## Related

- [Installation](/getting-started/installation/): the release installer, prerequisites, and verification.
- [Troubleshooting](/operations/troubleshooting/): protocol mismatch, connection, and lock failures.
- [CLI commands and flags](/reference/cli/): the full `update` signature and the fleet commands used after a restart.
- [Environment variables and precedence](/reference/environment/): `OMP_WEB_UPDATE_URL` and the fleet port.
- [Files and directories](/reference/files/): the pinned install, bin symlink, and data home layout.
- [Process lifecycle and recovery](/operations/lifecycle-and-recovery/): how the fleet spawns, stops, and respawns session daemons.
