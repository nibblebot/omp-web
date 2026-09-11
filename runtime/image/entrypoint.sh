#!/bin/sh
# Kubernetes provider session-runtime entrypoint (P5.4).
#
# Runs inside the per-workspace pod as tini's child. Env the provider always
# sets:
#   OMP_WORKSPACE_ROOT   /workspace (PVC)
#   OMP_WORKSPACE_DIR    /workspace/.checkout
#   HOME                 /workspace/.home
#   PI_CODING_AGENT_DIR  /workspace/.home/agent
#   OMP_WORKSPACE_ID, OMP_WORKSPACE_GENERATION, OMP_WORKSPACE_TOKEN,
#   OMP_PROVIDER_PROTO=2
# Env the fleet provider injects from the persisted pin:
#   OMP_PREP_SOURCE_REMOTE, OMP_PREP_REVISION, OMP_PREP_BRANCH
#   (source.local is rejected by the provider: a fleet-host path cannot be
#   reached from inside the cluster.)
#
# Preparation runs on EVERY pod start: new volumes are cloned and stamped,
# initialized volumes are validated from their marker alone so later commits
# and working files survive pod replacement, and any unusable marker fails
# closed before the daemon starts.
# The fleet's callback enrollment rides OMP_SESSION_CALLBACK_* pod env;
# daemon stdout/stderr go to the pod log.
set -eu

# Reserved environment names (runtime/bwrap-args.ts RESERVED_SECRET_ENV_KEYS:
# the preparation, callback, home, path, and provider-version groups). A
# profile secretRef must never shadow one of these; the provider rejects that
# before it makes any Kubernetes API call. The entrypoint validates the
# values of the reserved names it consumes, so a malformed pod spec fails
# here instead of booting a daemon with a hijacked workspace identity.
require_env() {
	eval "value=\${$1:-}"
	if [ -z "$value" ]; then
		echo "entrypoint: $1 is required" >&2
		exit 1
	fi
}

for name in OMP_WORKSPACE_ROOT OMP_WORKSPACE_DIR OMP_WORKSPACE_ID \
	OMP_WORKSPACE_GENERATION OMP_WORKSPACE_TOKEN HOME \
	OMP_PREP_SOURCE_REMOTE OMP_PREP_REVISION OMP_PREP_BRANCH; do
	require_env "$name"
done

# Provider version name: the image implements the OMP_PROVIDER_PROTO=2
# runtime contract, so a provider pinning any other version must not boot it.
if [ "${OMP_PROVIDER_PROTO:-}" != "2" ]; then
	echo "entrypoint: OMP_PROVIDER_PROTO must be 2, got ${OMP_PROVIDER_PROTO:-<unset>}" >&2
	exit 1
fi

# Home/path names: the daemon's home and checkout must be absolute paths on
# the workspace volume. A value outside it would put session state or the
# daemon cwd on the read-only root filesystem or in another workspace.
workspace_root="${OMP_WORKSPACE_ROOT%/}"
case "$HOME" in
	"$workspace_root"/*) ;;
	*)
		echo "entrypoint: HOME ($HOME) must be under OMP_WORKSPACE_ROOT ($OMP_WORKSPACE_ROOT)" >&2
		exit 1
		;;
esac
case "$OMP_WORKSPACE_DIR" in
	"$workspace_root"/*) ;;
	*)
		echo "entrypoint: OMP_WORKSPACE_DIR ($OMP_WORKSPACE_DIR) must be under OMP_WORKSPACE_ROOT ($OMP_WORKSPACE_ROOT)" >&2
		exit 1
		;;
esac
if [ -z "${PATH:-}" ]; then
	echo "entrypoint: PATH must be set" >&2
	exit 1
fi

# Callback names: the fleet supplies the URL, workspace, generation, and
# credential together from callback-env.json, and the daemon needs all four
# to enroll. A partial set is a broken handoff, never a direct-mode pod.
callback_present=0
for name in OMP_SESSION_CALLBACK_URL OMP_SESSION_CALLBACK_WORKSPACE \
	OMP_SESSION_CALLBACK_GENERATION OMP_SESSION_CALLBACK_TOKEN; do
	eval "value=\${$name:-}"
	if [ -n "$value" ]; then
		callback_present=$((callback_present + 1))
	fi
done
if [ "$callback_present" -ne 0 ] && [ "$callback_present" -ne 4 ]; then
	echo "entrypoint: OMP_SESSION_CALLBACK_* must be set together (URL, WORKSPACE, GENERATION, TOKEN); got $callback_present of 4" >&2
	exit 1
fi

# The workspace volume is owned by the pod's fsGroup; ensure the runtime
# user can write the private home before the daemon starts.
PI_CODING_AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/agent}"
mkdir -p "$OMP_WORKSPACE_ROOT" "$HOME" "$PI_CODING_AGENT_DIR"

# prepare-inpod.ts performs that preparation; the verified marker is written
# last, so retries reuse the persisted pin instead of resolving it again.
bun /opt/omp-web/runtime/image/prepare-inpod.ts

# Sessions never idle out on their own: the fleet is the sole idle-stop
# authority for provider workspaces (P6.4).
export OMP_SESSION_IDLE_TIMEOUT=0

# The daemon reads its launch env at server/index.ts boot; server/index.ts
# argv is parsed (session-config) and tolerates trailing flags, so
# --omp-workspace-token stays argv-visible for host-side identity checks.
# (Kubernetes identity is pod/API-based, not pid/cmdline-based; the token
# flag keeps the two providers' runtime entry contract identical.)
exec bun /opt/omp-web/server/index.ts \
  --cwd "$OMP_WORKSPACE_DIR" --port 0 \
  --omp-workspace-token="$OMP_WORKSPACE_TOKEN"
