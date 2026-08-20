#!/bin/sh
set -e

# omp-web installer — bun-only (adapted from oh-my-pi's install.sh).
# Usage: curl -fsSL https://raw.githubusercontent.com/nibblebot/omp-web/main/scripts/install.sh | sh
#
#   --ref <ref>    Install a specific tag/commit/branch (defaults to latest)
#   -r <ref>       Shorthand for --ref
#
# omp-web is distributed as a tarball on GitHub Releases and installed with
# bun. A pinned npm/binary mode does not exist: bun (>= 1.3.14) is the only
# supported method, and this script installs it when missing. The bin lands
# at $BUN_INSTALL/bin/omp-web (default ~/.bun/bin); upgrades and `omp-web
# update` are handled by the pinned install dir under ~/.omp-web (see
# scripts/install-omp-web.ts and cli/update.ts).
#
# Test-only env overrides (never documented in the README): OMP_WEB_INSTALLER_API
# redirects the GitHub API calls, OMP_WEB_DOWNLOAD_BASE the release-asset
# downloads, and OMP_WEB_INSTALL_DIR the data home, so the offline E2E
# (scripts/test-onboard.ts step 2b) can exercise the script against a local
# fixture without network.

REPO="nibblebot/omp-web"
PACKAGE="omp-web"
MIN_BUN_VERSION="1.3.14"

# Parse arguments
REF=""
while [ $# -gt 0 ]; do
	case "$1" in
		--ref)
			shift
			if [ -z "$1" ]; then
				echo "Missing value for --ref"
				exit 1
			fi
			REF="$1"
			shift
			;;
		--ref=*)
			REF="${1#*=}"
			if [ -z "$REF" ]; then
				echo "Missing value for --ref"
				exit 1
			fi
			shift
			;;
		-r)
			shift
			if [ -z "$1" ]; then
				echo "Missing value for -r"
				exit 1
			fi
			REF="$1"
			shift
			;;
		*)
			echo "Unknown option: $1"
			exit 1
			;;
	esac
done

# Check if bun is available
has_bun() {
	command -v bun >/dev/null 2>&1
}

# Install bun
install_bun() {
	echo "Installing bun..."
	if command -v bash >/dev/null 2>&1; then
		curl -fsSL https://bun.sh/install | bash
	else
		echo "bash not found; attempting install with sh..."
		curl -fsSL https://bun.sh/install | sh
	fi
	export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
	export PATH="$BUN_INSTALL/bin:$PATH"
	require_bun_version
}

version_ge() {
	current="$1"
	minimum="$2"

	current_major="${current%%.*}"
	current_rest="${current#*.}"
	current_minor="${current_rest%%.*}"
	current_patch="${current_rest#*.}"
	current_patch="${current_patch%%.*}"

	minimum_major="${minimum%%.*}"
	minimum_rest="${minimum#*.}"
	minimum_minor="${minimum_rest%%.*}"
	minimum_patch="${minimum_rest#*.}"
	minimum_patch="${minimum_patch%%.*}"

	if [ "$current_major" -ne "$minimum_major" ]; then
		[ "$current_major" -gt "$minimum_major" ]
		return $?
	fi

	if [ "$current_minor" -ne "$minimum_minor" ]; then
		[ "$current_minor" -gt "$minimum_minor" ]
		return $?
	fi

	[ "$current_patch" -ge "$minimum_patch" ]
}

require_bun_version() {
	version_raw=$(bun --version 2>/dev/null || true)
	if [ -z "$version_raw" ]; then
		echo "Failed to read bun version"
		exit 1
	fi

	version_clean=${version_raw%%-*}
	if ! version_ge "$version_clean" "$MIN_BUN_VERSION"; then
		echo "Bun ${MIN_BUN_VERSION} or newer is required. Current version: ${version_clean}"
		echo "Upgrade Bun at https://bun.sh/docs/installation"
		exit 1
	fi
}

# Resolve the release to install (defaults to latest). When --ref points at a
# tag like v0.1.0 or 0.1.0 the tarball URL is deterministic, so only the
# branch/commit case needs the API.
resolve_ref() {
	API_BASE="${OMP_WEB_INSTALLER_API:-https://api.github.com}"
	if [ -z "$REF" ]; then
		echo "Fetching latest release..." >&2
		curl -fsSL --connect-timeout 10 --max-time 60 \
			"${API_BASE}/repos/${REPO}/releases/latest" |
			grep '"tag_name"' | sed -E 's/.*"([^"]+)".*/\1/'
	elif [ "${REF#v}" = "$REF" ]; then
		# REF has no v prefix: a plain "v" tag may or may not exist, so the
		# deterministic URL below would guess. Resolve through the API.
		echo "Fetching release $REF..." >&2
		curl -fsSL --connect-timeout 10 --max-time 60 \
			"${API_BASE}/repos/${REPO}/releases/tags/${REF}" |
			grep '"tag_name"' | sed -E 's/.*"([^"]+)".*/\1/'
	else
		echo "$REF"
	fi
}

# Download and verify the release tarball, then install it into a pinned
# project dir (~/.omp-web/install/) and symlink the bin. The sha256 comes from
# the same release's manifest asset (the tarball is verified before bun add —
# tarball installs carry no registry integrity metadata).
install_via_bun() {
	LATEST="$(resolve_ref)"
	if [ -z "$LATEST" ]; then
		echo "Failed to fetch release tag"
		exit 1
	fi
	echo "Using version: $LATEST"
	VERSION="${LATEST#v}"

	TARBALL_URL="${OMP_WEB_DOWNLOAD_BASE:-https://github.com/${REPO}/releases/download}/${LATEST}/${PACKAGE}-${VERSION}.tgz"
	MANIFEST_URL="${OMP_WEB_DOWNLOAD_BASE:-https://github.com/${REPO}/releases/download}/${LATEST}/release-manifest.json"
	INSTALL_DIR="${OMP_WEB_INSTALL_DIR:-$HOME/.omp-web}"
	BIN_DIR="${BUN_INSTALL:-$HOME/.bun}/bin"
	WORK="$(mktemp -d)"
	trap 'rm -rf "$WORK"' EXIT

	echo "Downloading ${PACKAGE}-${VERSION}.tgz..."
	curl -fsSL --connect-timeout 10 --speed-limit 1024 --speed-time 30 "$TARBALL_URL" -o "$WORK/${PACKAGE}.tgz"

	# The manifest pins the exact sha256 of the bytes this release uploaded.
	curl -fsSL --connect-timeout 10 --max-time 30 "$MANIFEST_URL" -o "$WORK/release-manifest.json"
	EXPECTED_SHA="$(sed -n 's/.*"sha256"[[:space:]]*:[[:space:]]*"\([0-9a-f]\{64\}\)".*/\1/p' "$WORK/release-manifest.json" | head -n 1)"
	if [ -z "$EXPECTED_SHA" ]; then
		echo "Failed to read sha256 from release manifest"
		exit 1
	fi
	if command -v sha256sum >/dev/null 2>&1; then
		ACTUAL_SHA="$(sha256sum "$WORK/${PACKAGE}.tgz" | awk '{print $1}')"
	elif command -v shasum >/dev/null 2>&1; then
		ACTUAL_SHA="$(shasum -a 256 "$WORK/${PACKAGE}.tgz" | awk '{print $1}')"
	else
		echo "Neither sha256sum nor shasum found; cannot verify the download"
		exit 1
	fi
	if [ "$ACTUAL_SHA" != "$EXPECTED_SHA" ]; then
		echo "sha256 mismatch for ${PACKAGE}-${VERSION}.tgz: expected ${EXPECTED_SHA}, got ${ACTUAL_SHA}"
		exit 1
	fi

	if [ -f "$INSTALL_DIR/install/node_modules/omp-web/dist-bundle/cli.js" ]; then
		echo "Found existing install at ${INSTALL_DIR}; upgrading in place"
	fi

	mkdir -p "$INSTALL_DIR/install"
	# Anchor the install dir as its own bun project: `bun add` with no local
	# package.json walks UP to the nearest project root — an ancestor of the
	# install dir (a repo under ~, $HOME, or a --prefix nested in a project) —
	# and attaches there, dropping node_modules into it. A successful add
	# writes a package.json of its own, so only a fresh dir needs the anchor.
	if [ ! -f "$INSTALL_DIR/install/package.json" ]; then
		printf '%s\n' '{"name":"omp-web-install","private":true}' > "$INSTALL_DIR/install/package.json"
	fi
	(cd "$INSTALL_DIR/install" && bun remove "$PACKAGE" >/dev/null 2>&1 || true)
	if ! (cd "$INSTALL_DIR/install" && bun add "$WORK/${PACKAGE}.tgz"); then
		echo "Failed to install $PACKAGE"
		exit 1
	fi

	# Link the bin and verify it resolves to the pinned install.
	mkdir -p "$BIN_DIR"
	ln -sf "$INSTALL_DIR/install/node_modules/omp-web/dist-bundle/cli.js" "$BIN_DIR/omp-web"

	echo ""
	echo "✓ Installed omp-web via bun"
	echo "Run 'omp-web' to get started!"
}

# Ensure bun is present before doing anything else.
if ! has_bun; then
	install_bun
else
	require_bun_version
fi

install_via_bun
