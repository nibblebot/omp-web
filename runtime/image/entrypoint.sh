#!/bin/sh
# Kubernetes provider session-runtime entrypoint (P5.4).
#
# Runs inside the per-workspace pod. Env the provider always sets:
#   OMP_WORKSPACE_ROOT   /workspace (PVC)
#   OMP_WORKSPACE_DIR    /workspace/.checkout
#   HOME                 /workspace/.home
#   PI_CODING_AGENT_DIR  /workspace/.home/agent
#   OMP_WORKSPACE_ID, OMP_WORKSPACE_GENERATION, OMP_WORKSPACE_TOKEN,
#   OMP_PROVIDER_PROTO=1
# Env the fleet provider injects when the workspace was created with a pin:
#   OMP_PREP_SOURCE_REMOTE, OMP_PREP_REVISION, OMP_PREP_BRANCH
#   (source.local is rejected by the provider: a fleet-host path cannot be
#   reached from inside the cluster.)
#
# Initialization runs ONLY for a new workspace: prepare-workspace writes the
# verified .omp-workspace-init.json last, so a pod replacement on the same
# PVC skips preparation and goes straight to the daemon. A pod that starts
# on a claim already holding the marker never re-clones and never re-resolves
# the pin (retry/replacement safety). The fleet's callback enrollment rides
# OMP_SESSION_CALLBACK_* pod env; daemon stdout/stderr go to the pod log.
set -eu

if [ -z "${OMP_WORKSPACE_ROOT:-}" ]; then
	echo "entrypoint: OMP_WORKSPACE_ROOT is required" >&2
	exit 1
fi
if [ -z "${OMP_WORKSPACE_ID:-}" ] || [ -z "${OMP_WORKSPACE_GENERATION:-}" ]; then
	echo "entrypoint: OMP_WORKSPACE_ID and OMP_WORKSPACE_GENERATION are required" >&2
	exit 1
fi

: "${OMP_PREP_SOURCE_REMOTE:-}"

# The workspace volume is owned by the pod's fsGroup; ensure the runtime
# user can write the private home before the daemon starts.
mkdir -p "$OMP_WORKSPACE_ROOT" "$HOME" "$PI_CODING_AGENT_DIR"

MARKER="$OMP_WORKSPACE_ROOT/.omp-workspace-init.json"

if [ ! -f "$MARKER" ]; then
	if [ -n "$OMP_PREP_SOURCE_REMOTE" ]; then
		# Prepare the new workspace volume in-place: clone + verify + marker.
		# resolveWorkspacePin is ref-safe (resolves the pinned commit once);
		# the marker persists across pod crashes so retries never re-resolve.
		OMP_WORKSPACE_ID="$OMP_WORKSPACE_ID" \
			OMP_PREP_SOURCE_REMOTE="$OMP_PREP_SOURCE_REMOTE" \
			OMP_PREP_REVISION="${OMP_PREP_REVISION:-}" \
			OMP_PREP_BRANCH="${OMP_PREP_BRANCH:-}" \
			bun /opt/omp-web/runtime/image/prepare-inpod.ts
	elif [ -z "${OMP_PREP_SOURCE_REMOTE+x}" ]; then
		echo "entrypoint: new workspace volume requires OMP_PREP_SOURCE_REMOTE (a source.remote pin)" >&2
		exit 1
	fi
fi

# The daemon reads its launch env at server/index.ts boot; server/index.ts
# argv is parsed (session-config) and tolerates trailing flags, so
# --omp-workspace-token stays argv-visible for host-side identity checks.
# (Kubernetes identity is pod/API-based, not pid/cmdline-based; the token
# flag keeps the two providers' runtime entry contract identical.)
exec /opt/omp-web/node_modules/.bin/bun /opt/omp-web/server/index.ts \
	--omp-workspace-token="$OMP_WORKSPACE_TOKEN"
